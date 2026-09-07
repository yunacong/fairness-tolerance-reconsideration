import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const openApps: ReturnType<typeof createApp>[] = [];
const tempDirs: string[] = [];

function appAt(databasePath = ":memory:") {
  const app = createApp({ databasePath, researchExportToken: "test-token", codeVersion: "test-sha", serveWeb: false });
  openApps.push(app);
  return app;
}

afterEach(() => {
  while (openApps.length) openApps.pop()!.locals.db.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function consent(app: ReturnType<typeof createApp>) {
  const response = await request(app).post("/api/consent").send({
    consent_version: "1.0.0", idempotency_key: crypto.randomUUID(), adult: true,
    informed: true, voluntary: true, data_processing: true,
  }).expect(201);
  return response.body as { participant_id: string; session_id: string };
}

async function finishFlow(app: ReturnType<typeof createApp>, overrides: { threshold?: number; viewId?: string } = {}) {
  const identity = await consent(app);
  const session = identity.session_id;
  await request(app).post(`/api/sessions/${session}/background`).send({ age_range: "25-34", gender: "prefer_not_to_say", education: "postgraduate", ai_familiarity: 3 }).expect(200);
  await request(app).post(`/api/sessions/${session}/tutorial`).send({ completed: true, understood_probability: true, understood_thresholds: true }).expect(200);
  const content = await request(app).get(`/api/study/content?session_id=${session}`).expect(200);
  const viewId = overrides.viewId ?? content.body.active_views[0].view_id;
  await request(app).post(`/api/sessions/${session}/fairness-choice`).send({ view_id: viewId, decision_ms: 1200 }).expect(200);
  const pre = overrides.threshold ?? 18;
  await request(app).post(`/api/sessions/${session}/pre`).send({ threshold_pp: pre, confidence: 4, decision_ms: 900 }).expect(200);
  const exposure = await request(app).post(`/api/sessions/${session}/tradeoff-exposure`).send({}).expect(200);
  await request(app).post(`/api/sessions/${session}/comprehension`).send({ question_id: "meaning_of_lower_disparity", answer: "wrong" }).expect(200);
  await request(app).post(`/api/sessions/${session}/comprehension`).send({ question_id: "meaning_of_lower_disparity", answer: "lower" }).expect(200);
  await request(app).post(`/api/sessions/${session}/comprehension`).send({ question_id: "meaning_of_points", answer: "configurations" }).expect(200);
  await request(app).post(`/api/sessions/${session}/post`).send({ decision: "REVISE", final_threshold_pp: pre + 2, confidence: 5, feasibility: 4, reason_optional: "Accuracy made the initial tolerance feel achievable.", decision_ms: 1500 }).expect(200);
  await request(app).post(`/api/sessions/${session}/nasa-tlx`).send({ items: { mental: 30, physical: 0, temporal: 20, performance: 25, effort: 35, frustration: 10 } }).expect(200);
  await request(app).post(`/api/sessions/${session}/sus`).send({ items: [4, 2, 4, 2, 5, 1, 4, 2, 4, 1] }).expect(200);
  const completed = await request(app).post(`/api/sessions/${session}/finish`).send({}).expect(200);
  return { ...identity, viewId, exposure: exposure.body, completionCode: completed.body.completion_code as string };
}

describe("consent transaction and anonymous identities", () => {
  it("creates participant, session, and consent atomically only after full consent", async () => {
    const app = appAt();
    await request(app).post("/api/consent").send({
      consent_version: "1.0.0", idempotency_key: crypto.randomUUID(), adult: true,
      informed: true, voluntary: false, data_processing: true,
    }).expect(400);
    expect(app.locals.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n).toBe(0);
    const identity = await consent(app);
    expect(identity.participant_id).toMatch(/^P-[A-F0-9]{12}$/);
    expect(identity.session_id).toMatch(/^S-[A-F0-9]{12}$/);
    expect(app.locals.db.prepare("SELECT COUNT(*) AS n FROM consents").get().n).toBe(1);
  });

  it("is idempotent when a consent request is retried", async () => {
    const app = appAt();
    const payload = { consent_version: "1.0.0", idempotency_key: crypto.randomUUID(), adult: true, informed: true, voluntary: true, data_processing: true };
    const first = await request(app).post("/api/consent").send(payload).expect(201);
    const second = await request(app).post("/api/consent").send(payload).expect(200);
    expect(second.body).toEqual(first.body);
    expect(app.locals.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n).toBe(1);
  });
});

describe("frozen views and participant API boundary", () => {
  it("randomizes a persisted no-duplicate card order across participants", async () => {
    const app = appAt();
    const orders = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const identity = await consent(app);
      const response = await request(app).get(`/api/study/content?session_id=${identity.session_id}`).expect(200);
      const ids = response.body.active_views.map((view: { view_id: string }) => view.view_id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect(response.text).not.toContain("classification_cutoff");
      orders.add(ids.join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("returns trade-off points only for the selected view and never returns model cutoff", async () => {
    const app = appAt();
    const result = await finishFlow(app, { viewId: "C04" });
    expect(result.exposure.view.view_id).toBe("C04");
    expect(result.exposure.view.points.length).toBeGreaterThan(5);
    expect(JSON.stringify(result.exposure)).not.toMatch(/classification_cutoff/i);
    expect(result.exposure.view.points[0]).toEqual(expect.objectContaining({ accuracy_pp: expect.any(Number), fairness_disparity_pp: expect.any(Number) }));
  });
});

describe("persistence, isolation, retries, and raw questionnaires", () => {
  it("restores a completed session after closing and reopening the SQLite database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fairness-study-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "study.sqlite");
    const firstApp = appAt(databasePath);
    const result = await finishFlow(firstApp);
    firstApp.locals.db.close();
    openApps.splice(openApps.indexOf(firstApp), 1);
    const secondApp = appAt(databasePath);
    const restored = await request(secondApp).get(`/api/sessions/${result.session_id}`).expect(200);
    expect(restored.body.status).toBe("completed");
    expect(restored.body.completion_code).toBe(result.completionCode);
  });

  it("keeps two participants isolated and preserves comprehension attempts plus raw item counts", async () => {
    const app = appAt();
    const one = await finishFlow(app, { threshold: 10, viewId: "C01" });
    const two = await finishFlow(app, { threshold: 40, viewId: "C02" });
    expect(one.participant_id).not.toBe(two.participant_id);
    expect(one.session_id).not.toBe(two.session_id);
    expect(one.completionCode).not.toBe(two.completionCode);
    const rows = app.locals.db.prepare("SELECT participant_id, session_id FROM sessions ORDER BY started_at").all();
    expect(rows).toHaveLength(2);
    const firstCompleted = app.locals.db.prepare("SELECT status, completion_code FROM sessions WHERE session_id=?").get(one.session_id);
    expect(firstCompleted).toEqual({ status: "completed", completion_code: one.completionCode });
    expect(app.locals.db.prepare("SELECT threshold_pp FROM pre_decisions WHERE session_id=?").get(one.session_id).threshold_pp).toBe(10);
    expect(app.locals.db.prepare("SELECT threshold_pp FROM pre_decisions WHERE session_id=?").get(two.session_id).threshold_pp).toBe(40);
    expect(app.locals.db.prepare("SELECT COUNT(*) AS n FROM comprehension_attempts WHERE session_id=?").get(one.session_id).n).toBe(3);
    expect(app.locals.db.prepare("SELECT COUNT(*) AS n FROM nasa_tlx_items WHERE session_id=?").get(one.session_id).n).toBe(6);
    expect(app.locals.db.prepare("SELECT COUNT(*) AS n FROM sus_items WHERE session_id=?").get(one.session_id).n).toBe(10);
  });
});

describe("research export and correction log", () => {
  it("protects exports, returns versions/codebook, and records minimal corrections", async () => {
    const app = appAt();
    const result = await finishFlow(app);
    await request(app).get("/api/research/export.csv").expect(401);
    const csv = await request(app).get("/api/research/export.csv").set("x-research-token", "test-token").expect(200);
    expect(csv.text).toContain(result.session_id);
    expect(csv.text).toContain("comprehension_attempts");
    const codebook = await request(app).get("/api/research/codebook").set("x-research-token", "test-token").expect(200);
    expect(codebook.text).toContain("not model classification cutoffs");
    const manifest = await request(app).get("/api/research/manifest").set("x-research-token", "test-token").expect(200);
    expect(manifest.body.model_training_performed).toBe(false);
    await request(app).post("/api/research/corrections").set("x-research-token", "test-token").send({
      session_id: result.session_id, field_name: "background.education", old_value: "college",
      new_value: "undergraduate", reason: "Participant reported a data-entry mistake", researcher_ref: "QA-001",
    }).expect(201);
    expect(app.locals.db.prepare("SELECT COUNT(*) AS n FROM corrections").get().n).toBe(1);
  });
});
