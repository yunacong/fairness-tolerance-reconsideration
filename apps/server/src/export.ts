import type { StudyDatabase } from "./db.js";

const q = (value: unknown) => {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
};

export function exportRows(db: StudyDatabase) {
  const sessions = db.prepare(`
    SELECT s.*, c.consent_version, c.consented_at,
      b.age_range, b.gender, b.education, b.ai_familiarity,
      f.view_id, f.decision_ms AS view_decision_ms,
      p.threshold_pp AS pre_threshold_pp, p.confidence AS pre_confidence,
      p.decision_ms AS pre_decision_ms,
      t.point_count AS exposed_point_count, t.first_exposed_at,
      o.decision AS post_decision, o.final_threshold_pp, o.confidence AS post_confidence,
      o.feasibility, o.reason_optional, o.decision_ms AS post_decision_ms
    FROM sessions s
    LEFT JOIN consents c USING(session_id)
    LEFT JOIN background_answers b USING(session_id)
    LEFT JOIN fairness_choices f USING(session_id)
    LEFT JOIN pre_decisions p USING(session_id)
    LEFT JOIN tradeoff_exposures t USING(session_id)
    LEFT JOIN post_decisions o USING(session_id)
    ORDER BY s.started_at
  `).all() as Array<Record<string, unknown>>;

  return sessions.map((session) => {
    const sessionId = String(session.session_id);
    const comprehension = db.prepare(
      "SELECT question_id, attempt_no, answer, correct, answered_at FROM comprehension_attempts WHERE session_id = ? ORDER BY question_id, attempt_no",
    ).all(sessionId);
    const nasa = db.prepare(
      "SELECT item_key, raw_value FROM nasa_tlx_items WHERE session_id = ? ORDER BY item_key",
    ).all(sessionId);
    const sus = db.prepare(
      "SELECT item_number, raw_value FROM sus_items WHERE session_id = ? ORDER BY item_number",
    ).all(sessionId);
    const enriched: Record<string, unknown> = { ...session, comprehension_attempts: comprehension, nasa_tlx_raw: nasa, sus_raw: sus };
    return enriched;
  });
}

export function exportCsv(db: StudyDatabase) {
  const rows = exportRows(db);
  const headers = [
    "participant_id", "session_id", "status", "current_step", "study_version", "content_version",
    "tradeoff_dataset_version", "questionnaire_version", "code_version", "schema_version", "consent_version",
    "consented_at", "started_at", "completed_at", "completion_code", "card_order_json", "age_range", "gender",
    "education", "ai_familiarity", "view_id", "view_decision_ms", "pre_threshold_pp", "pre_confidence",
    "pre_decision_ms", "exposed_point_count", "first_exposed_at", "post_decision", "final_threshold_pp",
    "post_confidence", "feasibility", "reason_optional", "post_decision_ms", "comprehension_attempts",
    "nasa_tlx_raw", "sus_raw",
  ];
  return [headers.map(q).join(","), ...rows.map((row) => headers.map((header) => q(row[header])).join(","))].join("\n") + "\n";
}

export const PARTICIPANT_CODEBOOK = `

# Participant export fields

One CSV row represents one anonymous session. Participant and session IDs contain no direct identity.

- Version fields identify the frozen study, content, trade-off dataset, questionnaire, code, and database schema used for the session.
- 'view_id' is the complete selected Fairness View. Treat it descriptively/exploratorily; do not decompose it into independent group and metric preferences.
- 'pre_threshold_pp' and 'final_threshold_pp' are participant fairness-tolerance thresholds in 0-100 percentage points. They are not model classification cutoffs.
- 'comprehension_attempts' preserves every answer and retry in order.
- 'nasa_tlx_raw' preserves six unweighted 0-100 items.
- 'sus_raw' preserves ten 1-5 items; derived SUS scores are intentionally not substituted for raw responses.
- 'reason_optional' is the optional qualitative explanation collected immediately after POST.

The study has no control group. These data support within-session descriptive and exploratory comparisons, not a strict causal effect claim.
`;
