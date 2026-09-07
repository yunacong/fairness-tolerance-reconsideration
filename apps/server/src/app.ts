import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { STUDY_VERSIONS, runtimeConfig, type ServerOptions } from "./config.js";
import { createDatabase, type StudyDatabase } from "./db.js";
import { exportCsv, exportRows, PARTICIPANT_CODEBOOK } from "./export.js";
import { deterministicOrder } from "./randomize.js";
import { loadOfflineCodebook, loadResearchManifest, loadStudyContent } from "./studyContent.js";

const now = () => new Date().toISOString();
const anonymousId = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
const completionCode = () => `FAIR-${randomBytes(4).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-")}`;

const sessionSchema = z.string().regex(/^S-[A-F0-9]{12}$/);
const value1to5 = z.number().int().min(1).max(5);
const threshold = z.number().min(0).max(100);
const decisionMs = z.number().int().min(0).max(86_400_000);
const requiredConsent = z.object({
  consent_version: z.string().min(1),
  idempotency_key: z.string().uuid(),
  adult: z.literal(true),
  informed: z.literal(true),
  voluntary: z.literal(true),
  data_processing: z.literal(true),
});
const steps = ["background", "tutorial", "scenario", "orientation", "views", "pre", "tradeoff", "comprehension", "post", "nasa_tlx", "sus", "finish"] as const;

function sessionRow(db: StudyDatabase, sessionId: string) {
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
  if (!session) throw Object.assign(new Error("Unknown session"), { status: 404 });
  return session;
}

function advance(db: StudyDatabase, sessionId: string, step: typeof steps[number]) {
  db.prepare("UPDATE sessions SET current_step = ?, updated_at = ? WHERE session_id = ?").run(step, now(), sessionId);
}

function publicView<T extends { points: unknown }>(view: T): Omit<T, "points"> {
  const { points: _points, ...metadata } = view;
  return metadata;
}

function researcherOnly(expectedToken: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.header("x-research-token") !== expectedToken) {
      response.status(401).json({ error: "Researcher token required" });
      return;
    }
    next();
  };
}

export function createApp(options: ServerOptions = {}) {
  const config = runtimeConfig(options);
  const content = loadStudyContent(config.generatedContentDir);
  const manifest = loadResearchManifest(config.generatedContentDir);
  const db = createDatabase(config.databasePath);
  const app = express();
  app.locals.db = db;
  app.locals.studyContent = content;
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/health", (_request, response) => response.json({ ok: true, study_version: STUDY_VERSIONS.study_version }));
  app.get("/api/study/meta", (_request, response) => response.json({
    ...STUDY_VERSIONS,
    content_version: content.content_version,
    tradeoff_dataset_version: content.tradeoff_dataset_version,
    code_version: config.codeVersion,
    active_view_ids: content.active_views.map((view) => view.view_id),
    positive_outcome: content.positive_outcome,
    utility: content.utility,
  }));

  app.post("/api/consent", (request, response) => {
    const input = requiredConsent.parse(request.body);
    const existing = db.prepare("SELECT participant_id, session_id FROM sessions WHERE idempotency_key = ?").get(input.idempotency_key) as { participant_id: string; session_id: string } | undefined;
    if (existing) {
      response.json(existing);
      return;
    }
    const participantId = anonymousId("P");
    const sessionId = anonymousId("S");
    const timestamp = now();
    const order = deterministicOrder(content.active_views, sessionId).map((view) => view.view_id);
    db.transaction(() => {
      db.prepare("INSERT INTO participants(participant_id, created_at) VALUES (?, ?)").run(participantId, timestamp);
      db.prepare(`INSERT INTO sessions(
        session_id, participant_id, idempotency_key, study_version, content_version, tradeoff_dataset_version,
        questionnaire_version, code_version, schema_version, card_order_json, current_step, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'background', ?, ?)`).run(
        sessionId, participantId, input.idempotency_key, STUDY_VERSIONS.study_version, content.content_version,
        content.tradeoff_dataset_version, STUDY_VERSIONS.questionnaire_version, config.codeVersion,
        STUDY_VERSIONS.schema_version, JSON.stringify(order), timestamp, timestamp,
      );
      db.prepare(`INSERT INTO consents(
        session_id, consent_version, adult, informed, voluntary, data_processing, consented_at
      ) VALUES (?, ?, 1, 1, 1, 1, ?)`).run(sessionId, input.consent_version, timestamp);
    })();
    response.status(201).json({ participant_id: participantId, session_id: sessionId });
  });

  app.get("/api/sessions/:sessionId", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    const session = sessionRow(db, sessionId);
    const pre = db.prepare("SELECT threshold_pp, confidence FROM pre_decisions WHERE session_id = ?").get(sessionId);
    const choice = db.prepare("SELECT view_id FROM fairness_choices WHERE session_id = ?").get(sessionId);
    response.json({ ...session, pre, choice });
  });

  app.patch("/api/sessions/:sessionId/step", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const { step } = z.object({ step: z.enum(steps) }).parse(request.body);
    advance(db, sessionId, step);
    response.json({ ok: true, current_step: step });
  });

  app.post("/api/sessions/:sessionId/background", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const input = z.object({
      age_range: z.enum(["18-24", "25-34", "35-44", "45-54", "55-64", "65+", "prefer_not_to_say"]),
      gender: z.enum(["woman", "man", "non_binary", "self_describe", "prefer_not_to_say"]),
      education: z.enum(["secondary_or_less", "college", "undergraduate", "postgraduate", "other", "prefer_not_to_say"]),
      ai_familiarity: value1to5,
    }).parse(request.body);
    db.prepare(`INSERT INTO background_answers(session_id, age_range, gender, education, ai_familiarity, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET age_range=excluded.age_range,
      gender=excluded.gender, education=excluded.education, ai_familiarity=excluded.ai_familiarity, submitted_at=excluded.submitted_at`
    ).run(sessionId, input.age_range, input.gender, input.education, input.ai_familiarity, now());
    advance(db, sessionId, "tutorial");
    response.json({ ok: true });
  });

  app.post("/api/sessions/:sessionId/tutorial", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const input = z.object({ completed: z.literal(true), understood_probability: z.literal(true), understood_thresholds: z.literal(true) }).parse(request.body);
    db.prepare(`INSERT INTO tutorial_progress(session_id, completed, understood_probability, understood_thresholds, completed_at)
      VALUES (?, 1, 1, 1, ?) ON CONFLICT(session_id) DO UPDATE SET completed=1, understood_probability=1,
      understood_thresholds=1, completed_at=excluded.completed_at`).run(sessionId, now());
    advance(db, sessionId, "scenario");
    response.json({ ok: true, ...input });
  });

  app.get("/api/study/content", (request, response) => {
    const sessionId = sessionSchema.parse(request.query.session_id);
    const session = sessionRow(db, sessionId);
    const order = JSON.parse(String(session.card_order_json)) as string[];
    const byId = new Map(content.active_views.map((view) => [view.view_id, view]));
    response.json({
      content_version: content.content_version,
      units: content.units,
      positive_outcome: content.positive_outcome,
      utility: content.utility,
      active_views: order.map((id) => publicView(byId.get(id)!)),
    });
  });

  app.post("/api/sessions/:sessionId/fairness-choice", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    const session = sessionRow(db, sessionId);
    const input = z.object({ view_id: z.string(), decision_ms: decisionMs }).parse(request.body);
    if (!content.active_views.some((view) => view.view_id === input.view_id)) throw Object.assign(new Error("Inactive or unknown view"), { status: 400 });
    db.prepare(`INSERT INTO fairness_choices(session_id, view_id, card_order_json, decision_ms, selected_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET view_id=excluded.view_id,
      card_order_json=excluded.card_order_json, decision_ms=excluded.decision_ms, selected_at=excluded.selected_at`
    ).run(sessionId, input.view_id, session.card_order_json, input.decision_ms, now());
    advance(db, sessionId, "pre");
    response.json({ ok: true });
  });

  app.post("/api/sessions/:sessionId/pre", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const choice = db.prepare("SELECT view_id FROM fairness_choices WHERE session_id = ?").get(sessionId) as { view_id: string } | undefined;
    if (!choice) throw Object.assign(new Error("Select a Fairness View before PRE"), { status: 409 });
    const input = z.object({ threshold_pp: threshold, confidence: value1to5, decision_ms: decisionMs }).parse(request.body);
    db.prepare(`INSERT INTO pre_decisions(session_id, view_id, threshold_pp, confidence, decision_ms, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET view_id=excluded.view_id,
      threshold_pp=excluded.threshold_pp, confidence=excluded.confidence, decision_ms=excluded.decision_ms,
      submitted_at=excluded.submitted_at`).run(sessionId, choice.view_id, input.threshold_pp, input.confidence, input.decision_ms, now());
    advance(db, sessionId, "tradeoff");
    response.json({ ok: true });
  });

  app.post("/api/sessions/:sessionId/tradeoff-exposure", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const choice = db.prepare("SELECT view_id FROM fairness_choices WHERE session_id = ?").get(sessionId) as { view_id: string } | undefined;
    const pre = db.prepare("SELECT 1 FROM pre_decisions WHERE session_id = ?").get(sessionId);
    if (!choice || !pre) throw Object.assign(new Error("PRE decision is required before trade-off exposure"), { status: 409 });
    const view = content.active_views.find((candidate) => candidate.view_id === choice.view_id)!;
    const timestamp = now();
    db.prepare(`INSERT INTO tradeoff_exposures(session_id, view_id, point_count, content_version,
      tradeoff_dataset_version, first_exposed_at, last_exposed_at, exposure_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(session_id) DO UPDATE SET last_exposed_at=excluded.last_exposed_at,
      exposure_count=tradeoff_exposures.exposure_count + 1`).run(
      sessionId, view.view_id, view.points.length, content.content_version, content.tradeoff_dataset_version, timestamp, timestamp,
    );
    advance(db, sessionId, "comprehension");
    response.json({ view, units: content.units, utility: content.utility });
  });

  app.post("/api/sessions/:sessionId/comprehension", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const input = z.object({ question_id: z.enum(["meaning_of_lower_disparity", "meaning_of_points"]), answer: z.string().min(1).max(80) }).parse(request.body);
    const expected = input.question_id === "meaning_of_lower_disparity" ? "lower" : "configurations";
    const correct = input.answer === expected;
    const previous = db.prepare("SELECT COUNT(*) AS count FROM comprehension_attempts WHERE session_id = ? AND question_id = ?").get(sessionId, input.question_id) as { count: number };
    db.prepare(`INSERT INTO comprehension_attempts(session_id, question_id, attempt_no, answer, correct, answered_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, input.question_id, previous.count + 1, input.answer, correct ? 1 : 0, now());
    const correctQuestions = db.prepare("SELECT COUNT(DISTINCT question_id) AS count FROM comprehension_attempts WHERE session_id = ? AND correct = 1").get(sessionId) as { count: number };
    if (correctQuestions.count === 2) advance(db, sessionId, "post");
    response.json({
      correct,
      attempt_no: previous.count + 1,
      all_correct: correctQuestions.count === 2,
      explanation: input.question_id === "meaning_of_lower_disparity"
        ? "A lower disparity means the observed difference between the two groups is smaller."
        : "Each point is a feasible model configuration; the technical model cutoff is intentionally not shown.",
    });
  });

  app.post("/api/sessions/:sessionId/post", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const pre = db.prepare("SELECT threshold_pp FROM pre_decisions WHERE session_id = ?").get(sessionId) as { threshold_pp: number } | undefined;
    if (!pre) throw Object.assign(new Error("PRE decision is missing"), { status: 409 });
    const correct = db.prepare("SELECT COUNT(DISTINCT question_id) AS count FROM comprehension_attempts WHERE session_id = ? AND correct = 1").get(sessionId) as { count: number };
    if (correct.count !== 2) throw Object.assign(new Error("Both comprehension questions must be answered correctly"), { status: 409 });
    const input = z.object({
      decision: z.enum(["KEEP", "REVISE"]), final_threshold_pp: threshold, confidence: value1to5,
      feasibility: value1to5, reason_optional: z.string().max(2000).optional().default(""), decision_ms: decisionMs,
    }).parse(request.body);
    if (input.decision === "KEEP" && input.final_threshold_pp !== pre.threshold_pp) {
      throw Object.assign(new Error("KEEP must retain the PRE threshold"), { status: 400 });
    }
    db.prepare(`INSERT INTO post_decisions(session_id, decision, final_threshold_pp, confidence, feasibility,
      reason_optional, decision_ms, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET decision=excluded.decision, final_threshold_pp=excluded.final_threshold_pp,
      confidence=excluded.confidence, feasibility=excluded.feasibility, reason_optional=excluded.reason_optional,
      decision_ms=excluded.decision_ms, submitted_at=excluded.submitted_at`).run(
      sessionId, input.decision, input.final_threshold_pp, input.confidence, input.feasibility,
      input.reason_optional || null, input.decision_ms, now(),
    );
    advance(db, sessionId, "nasa_tlx");
    response.json({ ok: true });
  });

  app.post("/api/sessions/:sessionId/nasa-tlx", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const item = z.number().int().min(0).max(100);
    const input = z.object({ items: z.object({ mental: item, physical: item, temporal: item, performance: item, effort: item, frustration: item }) }).parse(request.body);
    const timestamp = now();
    db.transaction(() => {
      for (const [key, value] of Object.entries(input.items)) {
        db.prepare(`INSERT INTO nasa_tlx_items(session_id, item_key, raw_value, submitted_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, item_key) DO UPDATE SET raw_value=excluded.raw_value, submitted_at=excluded.submitted_at`
        ).run(sessionId, key, value, timestamp);
      }
      advance(db, sessionId, "sus");
    })();
    response.json({ ok: true, raw_item_count: 6 });
  });

  app.post("/api/sessions/:sessionId/sus", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    sessionRow(db, sessionId);
    const input = z.object({ items: z.array(value1to5).length(10) }).parse(request.body);
    const timestamp = now();
    db.transaction(() => {
      input.items.forEach((value, index) => db.prepare(`INSERT INTO sus_items(session_id, item_number, raw_value, submitted_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id, item_number) DO UPDATE SET raw_value=excluded.raw_value,
        submitted_at=excluded.submitted_at`).run(sessionId, index + 1, value, timestamp));
      advance(db, sessionId, "finish");
    })();
    response.json({ ok: true, raw_item_count: 10 });
  });

  app.post("/api/sessions/:sessionId/finish", (request, response) => {
    const sessionId = sessionSchema.parse(request.params.sessionId);
    const session = sessionRow(db, sessionId);
    if (session.completion_code) {
      response.json({ completion_code: session.completion_code });
      return;
    }
    const required = {
      background: "background_answers", tutorial: "tutorial_progress", choice: "fairness_choices", pre: "pre_decisions",
      exposure: "tradeoff_exposures", post: "post_decisions",
    };
    for (const [name, table] of Object.entries(required)) {
      const record = db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ?`).get(sessionId);
      if (!record) throw Object.assign(new Error(`Cannot finish: ${name} is incomplete`), { status: 409 });
    }
    const comprehension = db.prepare("SELECT COUNT(DISTINCT question_id) AS count FROM comprehension_attempts WHERE session_id = ? AND correct = 1").get(sessionId) as { count: number };
    const nasa = db.prepare("SELECT COUNT(*) AS count FROM nasa_tlx_items WHERE session_id = ?").get(sessionId) as { count: number };
    const sus = db.prepare("SELECT COUNT(*) AS count FROM sus_items WHERE session_id = ?").get(sessionId) as { count: number };
    if (comprehension.count !== 2 || nasa.count !== 6 || sus.count !== 10) throw Object.assign(new Error("Cannot finish: required raw items are incomplete"), { status: 409 });
    const code = completionCode();
    const timestamp = now();
    db.prepare("UPDATE sessions SET status='completed', current_step='finish', completion_code=?, completed_at=?, updated_at=? WHERE session_id=?")
      .run(code, timestamp, timestamp, sessionId);
    response.json({ completion_code: code });
  });

  const research = researcherOnly(config.researchExportToken);
  app.get("/api/research/export.csv", research, (_request, response) => {
    response.type("text/csv").attachment(`fairness-study-${new Date().toISOString().slice(0, 10)}.csv`).send(exportCsv(db));
  });
  app.get("/api/research/export.json", research, (_request, response) => response.json({
    exported_at: now(), versions: { ...STUDY_VERSIONS, content_version: content.content_version, tradeoff_dataset_version: content.tradeoff_dataset_version, code_version: config.codeVersion },
    sessions: exportRows(db),
  }));
  app.get("/api/research/codebook", research, (_request, response) => response.type("text/markdown").send(loadOfflineCodebook(config.generatedContentDir) + PARTICIPANT_CODEBOOK));
  app.get("/api/research/manifest", research, (_request, response) => response.json({ ...manifest, runtime: { schema_version: STUDY_VERSIONS.schema_version, code_version: config.codeVersion } }));
  app.post("/api/research/corrections", research, (request, response) => {
    const input = z.object({ session_id: sessionSchema, field_name: z.string().min(1).max(120), old_value: z.string().max(2000).optional(), new_value: z.string().max(2000).optional(), reason: z.string().min(1).max(1000), researcher_ref: z.string().min(1).max(120) }).parse(request.body);
    sessionRow(db, input.session_id);
    const result = db.prepare(`INSERT INTO corrections(session_id, field_name, old_value, new_value, reason, researcher_ref, corrected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.session_id, input.field_name, input.old_value ?? null, input.new_value ?? null, input.reason, input.researcher_ref, now());
    response.status(201).json({ correction_id: result.lastInsertRowid });
  });

  if (config.serveWeb) {
    const here = dirname(fileURLToPath(import.meta.url));
    const webDist = resolve(here, "../../web/dist");
    if (existsSync(webDist)) {
      app.use(express.static(webDist));
      app.use((_request, response, next) => {
        if (_request.method !== "GET" || _request.path.startsWith("/api/")) return next();
        response.sendFile(resolve(webDist, "index.html"));
      });
    }
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "Invalid request", issues: error.issues });
      return;
    }
    const typed = error as Error & { status?: number };
    response.status(typed.status ?? 500).json({ error: typed.message || "Unexpected server error" });
  });
  return app;
}
