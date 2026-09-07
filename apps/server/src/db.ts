import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type StudyDatabase = Database.Database;

export function createDatabase(path: string): StudyDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      participant_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL REFERENCES participants(participant_id),
      idempotency_key TEXT NOT NULL UNIQUE,
      study_version TEXT NOT NULL,
      content_version TEXT NOT NULL,
      tradeoff_dataset_version TEXT NOT NULL,
      questionnaire_version TEXT NOT NULL,
      code_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      card_order_json TEXT NOT NULL,
      current_step TEXT NOT NULL DEFAULT 'background',
      status TEXT NOT NULL DEFAULT 'in_progress',
      completion_code TEXT UNIQUE,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS consents (
      consent_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),
      consent_version TEXT NOT NULL,
      adult INTEGER NOT NULL CHECK(adult = 1),
      informed INTEGER NOT NULL CHECK(informed = 1),
      voluntary INTEGER NOT NULL CHECK(voluntary = 1),
      data_processing INTEGER NOT NULL CHECK(data_processing = 1),
      consented_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS background_answers (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      age_range TEXT NOT NULL,
      gender TEXT NOT NULL,
      education TEXT NOT NULL,
      ai_familiarity INTEGER NOT NULL CHECK(ai_familiarity BETWEEN 1 AND 5),
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tutorial_progress (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      completed INTEGER NOT NULL CHECK(completed = 1),
      understood_probability INTEGER NOT NULL CHECK(understood_probability = 1),
      understood_thresholds INTEGER NOT NULL CHECK(understood_thresholds = 1),
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fairness_choices (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      view_id TEXT NOT NULL,
      card_order_json TEXT NOT NULL,
      decision_ms INTEGER NOT NULL CHECK(decision_ms >= 0),
      selected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pre_decisions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      view_id TEXT NOT NULL,
      threshold_pp REAL NOT NULL CHECK(threshold_pp BETWEEN 0 AND 100),
      confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 5),
      decision_ms INTEGER NOT NULL CHECK(decision_ms >= 0),
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tradeoff_exposures (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      view_id TEXT NOT NULL,
      point_count INTEGER NOT NULL,
      content_version TEXT NOT NULL,
      tradeoff_dataset_version TEXT NOT NULL,
      first_exposed_at TEXT NOT NULL,
      last_exposed_at TEXT NOT NULL,
      exposure_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS comprehension_attempts (
      attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      question_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      answer TEXT NOT NULL,
      correct INTEGER NOT NULL,
      answered_at TEXT NOT NULL,
      UNIQUE(session_id, question_id, attempt_no)
    );
    CREATE TABLE IF NOT EXISTS post_decisions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      decision TEXT NOT NULL CHECK(decision IN ('KEEP', 'REVISE')),
      final_threshold_pp REAL NOT NULL CHECK(final_threshold_pp BETWEEN 0 AND 100),
      confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 5),
      feasibility INTEGER NOT NULL CHECK(feasibility BETWEEN 1 AND 5),
      reason_optional TEXT,
      decision_ms INTEGER NOT NULL CHECK(decision_ms >= 0),
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nasa_tlx_items (
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      item_key TEXT NOT NULL,
      raw_value INTEGER NOT NULL CHECK(raw_value BETWEEN 0 AND 100),
      submitted_at TEXT NOT NULL,
      PRIMARY KEY(session_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS sus_items (
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      item_number INTEGER NOT NULL CHECK(item_number BETWEEN 1 AND 10),
      raw_value INTEGER NOT NULL CHECK(raw_value BETWEEN 1 AND 5),
      submitted_at TEXT NOT NULL,
      PRIMARY KEY(session_id, item_number)
    );
    CREATE TABLE IF NOT EXISTS corrections (
      correction_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL,
      researcher_ref TEXT NOT NULL,
      corrected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comprehension_session ON comprehension_attempts(session_id, question_id);
  `);
  return db;
}
