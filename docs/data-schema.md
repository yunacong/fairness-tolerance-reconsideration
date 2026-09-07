# Participant data schema and codebook

SQLite is initialized on server start with foreign keys enabled and WAL journalling. Every research row connects to exactly one anonymous `session_id`; `participant_id` is also anonymous and is never derived from background answers.

## Core tables

| Table | Purpose | Key content |
|---|---|---|
| `participants` | Anonymous participant creation | participant ID, creation time |
| `sessions` | Session/version/progress boundary | six version fields, persisted randomized card order, completion code/status |
| `consents` | Consent evidence | four required confirmations, consent version/time |
| `background_answers` | Minimal background | age range, gender, education, AI familiarity |
| `tutorial_progress` | Tutorial completion | probability and threshold distinction confirmations |
| `fairness_choices` | Complete view choice | `view_id`, randomized order, decision time |
| `pre_decisions` | Initial judgement | view ID, tolerance pp, confidence, time |
| `tradeoff_exposures` | Exact frozen exposure | view ID, point count, content/data versions, exposure times/count |
| `comprehension_attempts` | Every first answer and retry | question, attempt number, raw answer, correctness, time |
| `post_decisions` | Final judgement | KEEP/REVISE, final tolerance, confidence, feasibility, adjacent optional reason, time |
| `nasa_tlx_items` | Raw workload responses | six unweighted 0–100 items |
| `sus_items` | Raw usability responses | ten 1–5 items |
| `corrections` | Minimal append-only QA log | old/new values, reason, researcher reference, time |

## Version fields

- `study_version`: procedure/study release.
- `content_version`: participant wording and three Active Views.
- `tradeoff_dataset_version`: frozen participant point dataset.
- `questionnaire_version`: Raw NASA-TLX and SUS forms.
- `code_version`: deployed software version/commit override.
- `schema_version`: SQLite/export schema.

## Analysis boundaries

Thresholds use percentage points (`0–100`). They are participant fairness-tolerance decisions, never technical model classification cutoffs. `view_id` is analysed as one complete descriptive/exploratory category. Raw questionnaire items are preserved; derived scores should be created in a documented analysis script without overwriting raw data.
