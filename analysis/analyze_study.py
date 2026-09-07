from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import sqlite3
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from scipy import stats


ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--database", type=Path, default=ROOT.parent / "data" / "study_final.sqlite")
parser.add_argument("--output", type=Path, default=ROOT.parent / "data" / "analysis_exports")
parser.add_argument("--coding", type=Path, default=ROOT.parent / "data" / "qualitative_codes.csv")
args = parser.parse_args()
DB_PATH = args.database
WORK_OUT = args.output
FIG_OUT = args.output / "figures"

WORK_OUT.mkdir(parents=True, exist_ok=True)
FIG_OUT.mkdir(parents=True, exist_ok=True)


def read_table(conn: sqlite3.Connection, name: str) -> pd.DataFrame:
    return pd.read_sql_query(f'SELECT * FROM "{name}"', conn)


def py_value(value):
    if value is None or value is pd.NA:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        if np.isnan(value):
            return None
        return float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


def records(df: pd.DataFrame) -> list[dict]:
    return [{str(k): py_value(v) for k, v in row.items()} for row in df.to_dict("records")]


def descriptive(series: pd.Series | np.ndarray) -> dict:
    x = pd.Series(series, dtype="float64").dropna()
    return {
        "n": int(x.size),
        "mean": float(x.mean()),
        "sd": float(x.std(ddof=1)) if x.size > 1 else None,
        "median": float(x.median()),
        "q1": float(x.quantile(0.25)),
        "q3": float(x.quantile(0.75)),
        "iqr": float(x.quantile(0.75) - x.quantile(0.25)),
        "min": float(x.min()),
        "max": float(x.max()),
    }


def mean_ci95(series: pd.Series | np.ndarray) -> tuple[float, float]:
    x = pd.Series(series, dtype="float64").dropna().to_numpy()
    if x.size < 2:
        return (float("nan"), float("nan"))
    margin = stats.t.ppf(0.975, x.size - 1) * stats.sem(x)
    return (float(x.mean() - margin), float(x.mean() + margin))


def exact_signed_rank(diff: pd.Series | np.ndarray) -> dict:
    """Exact conditional sign-flip p-value using the observed average ranks.

    This remains exact in the presence of tied absolute differences because it
    enumerates all signs conditional on the observed absolute ranks. Zero
    differences are excluded, matching the Wilcoxon zero_method='wilcox'.
    """
    x = np.asarray(diff, dtype=float)
    x = x[~np.isnan(x)]
    x = x[x != 0]
    abs_ranks = stats.rankdata(np.abs(x), method="average")
    total = float(abs_ranks.sum())
    t_plus = float(abs_ranks[x > 0].sum())
    t_minus = float(abs_ranks[x < 0].sum())
    observed_deviation = abs(t_plus - total / 2.0)
    extreme = 0
    permutations = 1 << len(x)
    for mask in range(permutations):
        perm_plus = 0.0
        for idx, rank in enumerate(abs_ranks):
            if mask & (1 << idx):
                perm_plus += float(rank)
        if abs(perm_plus - total / 2.0) >= observed_deviation - 1e-12:
            extreme += 1
    return {
        "n_nonzero": int(len(x)),
        "t_plus": t_plus,
        "t_minus": t_minus,
        "w_min": min(t_plus, t_minus),
        "exact_two_sided_p": extreme / permutations,
        "rank_biserial": (t_plus - t_minus) / total if total else 0.0,
        "permutations": permutations,
    }


def holm_adjust(p_values: list[float]) -> list[float]:
    p = np.asarray(p_values, dtype=float)
    order = np.argsort(p)
    adjusted_sorted = np.maximum.accumulate((len(p) - np.arange(len(p))) * p[order])
    adjusted_sorted = np.minimum(adjusted_sorted, 1.0)
    adjusted = np.empty_like(adjusted_sorted)
    adjusted[order] = adjusted_sorted
    return adjusted.tolist()


def save_figure(fig: plt.Figure, stem: str) -> None:
    fig.savefig(FIG_OUT / f"{stem}.png", dpi=300, bbox_inches="tight", facecolor="white")
    fig.savefig(FIG_OUT / f"{stem}.pdf", bbox_inches="tight", facecolor="white")
    plt.close(fig)


db_hash = hashlib.sha256(DB_PATH.read_bytes()).hexdigest()
conn = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro&immutable=1", uri=True)
conn.execute("PRAGMA query_only = ON")

table_names = [
    row[0]
    for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
]
tables = {name: read_table(conn, name) for name in table_names}

participants = tables["participants"]
sessions = tables["sessions"]
background = tables["background_answers"]
consents = tables["consents"]
tutorial = tables["tutorial_progress"]
fairness = tables["fairness_choices"]
pre = tables["pre_decisions"]
tradeoff = tables["tradeoff_exposures"]
comp = tables["comprehension_attempts"]
post = tables["post_decisions"]
qual = tables["qualitative_responses"]
nasa = tables["nasa_tlx_items"]
sus = tables["sus_items"]
corrections = tables["corrections"]

completed = sessions.loc[sessions["status"].eq("completed")].copy()
completed_session_ids = set(completed["session_id"])

# Stable short analysis identifiers avoid unwieldy database IDs in figures/quotes.
short_id_map = {
    participant_id: f"P{idx:02d}"
    for idx, participant_id in enumerate(sorted(participants["participant_id"].tolist()), start=1)
}

analysis = (
    completed[
        [
            "session_id",
            "participant_id",
            "status",
            "completion_code",
            "started_at",
            "completed_at",
        ]
    ]
    .merge(background, on="session_id", how="left", validate="one_to_one")
    .merge(
        fairness[["session_id", "view_id", "decision_ms"]].rename(
            columns={"decision_ms": "view_decision_ms"}
        ),
        on="session_id",
        how="left",
        validate="one_to_one",
    )
    .merge(
        pre[["session_id", "view_id", "threshold_pp", "confidence", "decision_ms"]].rename(
            columns={
                "view_id": "pre_view_id",
                "threshold_pp": "pre_threshold",
                "confidence": "pre_confidence",
                "decision_ms": "pre_decision_ms",
            }
        ),
        on="session_id",
        how="left",
        validate="one_to_one",
    )
    .merge(
        post[
            [
                "session_id",
                "decision",
                "final_threshold_pp",
                "confidence",
                "feasibility",
                "decision_ms",
            ]
        ].rename(
            columns={
                "final_threshold_pp": "post_threshold",
                "confidence": "post_confidence",
                "decision_ms": "post_decision_ms",
            }
        ),
        on="session_id",
        how="left",
        validate="one_to_one",
    )
    .merge(
        qual[["session_id", "text", "skipped"]].rename(
            columns={"text": "qualitative_text", "skipped": "qualitative_skipped"}
        ),
        on="session_id",
        how="left",
        validate="one_to_one",
    )
)
analysis.insert(0, "analysis_id", analysis["participant_id"].map(short_id_map))
analysis["delta"] = analysis["post_threshold"] - analysis["pre_threshold"]
analysis["change_direction"] = np.select(
    [analysis["delta"] > 0, analysis["delta"] < 0], ["Increase", "Decrease"], default="Unchanged"
)
analysis["confidence_delta"] = analysis["post_confidence"] - analysis["pre_confidence"]
analysis["decision_delta_consistent"] = np.where(
    analysis["decision"].eq("KEEP"), analysis["delta"].eq(0), analysis["delta"].ne(0)
)

# Comprehension-derived variables.
questions = sorted(comp["question_id"].unique().tolist())
first_attempt = comp.loc[comp["attempt_no"].eq(1)].copy()
first_by_session = (
    first_attempt.groupby("session_id")["correct"].agg(first_correct="sum", first_questions="count").reset_index()
)
retry_by_session = (
    comp.groupby("session_id").size().sub(len(questions)).rename("retry_count").reset_index()
)
last_attempt = (
    comp.sort_values(["session_id", "question_id", "attempt_no"])
    .groupby(["session_id", "question_id"], as_index=False)
    .tail(1)
)
final_by_session = (
    last_attempt.groupby("session_id")["correct"].agg(final_correct="sum", final_questions="count").reset_index()
)
analysis = analysis.merge(first_by_session, on="session_id", how="left", validate="one_to_one")
analysis = analysis.merge(retry_by_session, on="session_id", how="left", validate="one_to_one")
analysis = analysis.merge(final_by_session, on="session_id", how="left", validate="one_to_one")
analysis["first_pass_all"] = analysis["first_correct"].eq(len(questions))
analysis["final_pass_all"] = analysis["final_correct"].eq(len(questions))

# SUS standard scoring: odd items contribute raw-1; even items contribute 5-raw; total × 2.5.
sus_wide = sus.pivot(index="session_id", columns="item_number", values="raw_value").sort_index(axis=1)
sus_wide.columns = [f"sus_item_{int(col)}" for col in sus_wide.columns]
sus_scored = pd.DataFrame(index=sus_wide.index)
for item in range(1, 11):
    raw_col = f"sus_item_{item}"
    sus_scored[f"sus_contribution_{item}"] = (
        sus_wide[raw_col] - 1 if item % 2 == 1 else 5 - sus_wide[raw_col]
    )
sus_score = sus_scored.sum(axis=1).mul(2.5).rename("sus_score")
analysis = analysis.merge(sus_wide.reset_index(), on="session_id", how="left", validate="one_to_one")
analysis = analysis.merge(sus_score.reset_index(), on="session_id", how="left", validate="one_to_one")

# NASA-TLX dimensions; Performance is retained in its administered direction (higher = greater success).
nasa_wide = nasa.pivot(index="session_id", columns="item_key", values="raw_value")
nasa_wide = nasa_wide.rename(columns={col: f"nasa_{col}" for col in nasa_wide.columns})
analysis = analysis.merge(nasa_wide.reset_index(), on="session_id", how="left", validate="one_to_one")
burden_dimensions = [
    "nasa_mental",
    "nasa_physical",
    "nasa_temporal",
    "nasa_effort",
    "nasa_frustration",
]
analysis["nasa_burden_mean_excl_performance"] = analysis[burden_dimensions].mean(axis=1)

analysis = analysis.sort_values("analysis_id").reset_index(drop=True)

# ---------------------------- Data-quality audit ----------------------------
inventory_rows = []
for name in table_names:
    df = tables[name]
    inventory_rows.append(
        {
            "table": name,
            "rows": int(len(df)),
            "distinct_sessions": int(df["session_id"].nunique()) if "session_id" in df.columns else None,
            "distinct_participants": int(df["participant_id"].nunique())
            if "participant_id" in df.columns
            else None,
        }
    )
table_inventory = pd.DataFrame(inventory_rows)

quality_rows: list[dict] = []


def quality(check: str, observed, expected, passed: bool, notes: str = "") -> None:
    quality_rows.append(
        {
            "check": check,
            "observed": observed,
            "expected": expected,
            "status": "PASS" if passed else "REVIEW",
            "notes": notes,
        }
    )


integrity_result = conn.execute("PRAGMA integrity_check").fetchone()[0]
foreign_key_issues = conn.execute("PRAGMA foreign_key_check").fetchall()
quality("SQLite integrity", integrity_result, "ok", integrity_result == "ok")
quality("Foreign-key violations", len(foreign_key_issues), 0, len(foreign_key_issues) == 0)
quality("Completed sessions", len(completed), 25, len(completed) == 25)
quality("All sessions completed", int(sessions["status"].eq("completed").sum()), len(sessions), sessions["status"].eq("completed").all())
quality("Unique participant IDs", participants["participant_id"].nunique(), len(participants), not participants["participant_id"].duplicated().any())
quality("One session per participant", sessions["participant_id"].nunique(), len(sessions), not sessions["participant_id"].duplicated().any())
quality("Unique session IDs", sessions["session_id"].nunique(), len(sessions), not sessions["session_id"].duplicated().any())
quality("Unique completion codes", sessions["completion_code"].nunique(), len(sessions), sessions["completion_code"].notna().all() and not sessions["completion_code"].duplicated().any())

expected_one_per_session = [
    "background_answers",
    "consents",
    "fairness_choices",
    "post_decisions",
    "pre_decisions",
    "qualitative_responses",
    "tradeoff_exposures",
    "tutorial_progress",
]
for name in expected_one_per_session:
    df = tables[name]
    observed_set = set(df["session_id"])
    passed = len(df) == 25 and observed_set == completed_session_ids and not df["session_id"].duplicated().any()
    quality(f"{name}: one record per completed session", len(df), 25, passed)

quality(
    "SUS item completeness",
    f"{len(sus)} rows; {sus['session_id'].nunique()} sessions",
    "250 rows; 25 sessions; items 1-10 each",
    len(sus) == 250
    and set(sus["session_id"]) == completed_session_ids
    and sus.groupby("session_id")["item_number"].apply(lambda x: set(x) == set(range(1, 11))).all(),
)
quality(
    "NASA-TLX item completeness",
    f"{len(nasa)} rows; {nasa['session_id'].nunique()} sessions",
    "150 rows; 25 sessions; six dimensions each",
    len(nasa) == 150
    and set(nasa["session_id"]) == completed_session_ids
    and nasa.groupby("session_id")["item_key"]
    .apply(lambda x: set(x) == {"mental", "physical", "temporal", "performance", "effort", "frustration"})
    .all(),
)
quality(
    "Comprehension question coverage",
    f"{len(comp)} rows; questions={', '.join(questions)}",
    "Both questions for every session, plus valid retries",
    set(comp["session_id"]) == completed_session_ids
    and comp.groupby("session_id")["question_id"].apply(lambda x: set(x) == set(questions)).all(),
)
attempt_sequences_ok = all(
    attempts.tolist() == list(range(1, len(attempts) + 1))
    for _, attempts in comp.sort_values("attempt_no").groupby(["session_id", "question_id"])["attempt_no"]
)
quality("Comprehension attempt sequences", attempt_sequences_ok, True, attempt_sequences_ok)
quality("Final comprehension correctness", int(analysis["final_pass_all"].sum()), 25, analysis["final_pass_all"].all())

core_fields = [
    "view_id",
    "pre_threshold",
    "post_threshold",
    "decision",
    "pre_confidence",
    "post_confidence",
    "feasibility",
    "sus_score",
] + [f"nasa_{x}" for x in ["mental", "physical", "temporal", "performance", "effort", "frustration"]]
missing_core = int(analysis[core_fields].isna().sum().sum())
quality("Missing core analysis values", missing_core, 0, missing_core == 0)
qual_missing_expected = int((analysis["qualitative_skipped"].eq(1) & analysis["qualitative_text"].isna()).sum())
qual_unexplained_missing = int((analysis["qualitative_skipped"].eq(0) & analysis["qualitative_text"].fillna("").str.strip().eq("")).sum())
quality(
    "Qualitative missingness",
    f"{qual_missing_expected} skipped/null; {qual_unexplained_missing} unexplained blank",
    "Skipped responses may be null; submitted responses nonblank",
    qual_unexplained_missing == 0,
)
quality("Corrections table", len(corrections), 0, len(corrections) == 0, "No researcher corrections recorded.")

view_mismatches = int((analysis["view_id"] != analysis["pre_view_id"]).sum())
tradeoff_view = tradeoff[["session_id", "view_id"]].rename(columns={"view_id": "tradeoff_view_id"})
view_check = analysis[["session_id", "view_id"]].merge(tradeoff_view, on="session_id", validate="one_to_one")
tradeoff_mismatches = int((view_check["view_id"] != view_check["tradeoff_view_id"]).sum())
quality("Fairness View consistency across stages", view_mismatches + tradeoff_mismatches, 0, view_mismatches + tradeoff_mismatches == 0)

range_violations = {
    "threshold_0_100": int((~analysis["pre_threshold"].between(0, 100) | ~analysis["post_threshold"].between(0, 100)).sum()),
    "confidence_1_7": int((~analysis["pre_confidence"].between(1, 7) | ~analysis["post_confidence"].between(1, 7)).sum()),
    "feasibility_1_7": int((~analysis["feasibility"].between(1, 7)).sum()),
    "sus_items_1_5": int((~sus["raw_value"].between(1, 5)).sum()),
    "nasa_0_100": int((~nasa["raw_value"].between(0, 100)).sum()),
}
quality("Out-of-range values", sum(range_violations.values()), 0, sum(range_violations.values()) == 0, json.dumps(range_violations))

decision_inconsistent = analysis.loc[
    ~analysis["decision_delta_consistent"],
    ["analysis_id", "participant_id", "decision", "pre_threshold", "post_threshold", "delta"],
]
quality(
    "KEEP/REVISE agrees with numerical delta",
    f"{int(analysis['decision_delta_consistent'].sum())}/25 consistent",
    "25/25",
    decision_inconsistent.empty,
    "One REVISE record retained the same numerical threshold; preserved and flagged, not corrected."
    if not decision_inconsistent.empty
    else "",
)

# Chronology checks across the intended study sequence.
timestamp_frame = (
    sessions[["session_id", "started_at", "completed_at"]]
    .merge(consents[["session_id", "consented_at"]], on="session_id", validate="one_to_one")
    .merge(background[["session_id", "submitted_at"]].rename(columns={"submitted_at": "background_at"}), on="session_id", validate="one_to_one")
    .merge(tutorial[["session_id", "completed_at"]].rename(columns={"completed_at": "tutorial_at"}), on="session_id", validate="one_to_one")
    .merge(fairness[["session_id", "selected_at"]], on="session_id", validate="one_to_one")
    .merge(pre[["session_id", "submitted_at"]].rename(columns={"submitted_at": "pre_at"}), on="session_id", validate="one_to_one")
    .merge(tradeoff[["session_id", "first_exposed_at"]], on="session_id", validate="one_to_one")
    .merge(comp.groupby("session_id")["answered_at"].agg(comp_first="min", comp_last="max").reset_index(), on="session_id", validate="one_to_one")
    .merge(post[["session_id", "submitted_at"]].rename(columns={"submitted_at": "post_at"}), on="session_id", validate="one_to_one")
    .merge(qual[["session_id", "created_at"]].rename(columns={"created_at": "qual_at"}), on="session_id", validate="one_to_one")
    .merge(nasa.groupby("session_id")["submitted_at"].max().rename("nasa_at").reset_index(), on="session_id", validate="one_to_one")
    .merge(sus.groupby("session_id")["submitted_at"].max().rename("sus_at").reset_index(), on="session_id", validate="one_to_one")
)
time_cols = [
    "started_at",
    "consented_at",
    "background_at",
    "tutorial_at",
    "selected_at",
    "pre_at",
    "first_exposed_at",
    "comp_first",
    "comp_last",
    "post_at",
    "qual_at",
    "nasa_at",
    "sus_at",
    "completed_at",
]
for col in time_cols:
    timestamp_frame[col] = pd.to_datetime(timestamp_frame[col], errors="coerce", utc=True)
chronology_ok = timestamp_frame[time_cols].apply(
    lambda row: row.notna().all() and all(row.iloc[i] <= row.iloc[i + 1] for i in range(len(row) - 1)), axis=1
)
quality("Study-stage timestamp chronology", int(chronology_ok.sum()), 25, chronology_ok.all())

data_quality = pd.DataFrame(quality_rows)

# ---------------------------- Main statistics ----------------------------
threshold_stats = {
    "pre": descriptive(analysis["pre_threshold"]),
    "post": descriptive(analysis["post_threshold"]),
    "delta": descriptive(analysis["delta"]),
}
shapiro_threshold = stats.shapiro(analysis["delta"])
wilcoxon_threshold_approx = stats.wilcoxon(
    analysis["delta"], zero_method="wilcox", correction=False, alternative="two-sided", method="approx"
)
wilcoxon_threshold_exact = exact_signed_rank(analysis["delta"])
t_threshold = stats.ttest_rel(analysis["post_threshold"], analysis["pre_threshold"])
sign_threshold = stats.binomtest(
    int((analysis["delta"] > 0).sum()),
    int((analysis["delta"] != 0).sum()),
    p=0.5,
    alternative="two-sided",
)
threshold_tests = {
    "shapiro_w": float(shapiro_threshold.statistic),
    "shapiro_p": float(shapiro_threshold.pvalue),
    "primary_test": "Wilcoxon signed-rank; zeros excluded; exact conditional sign-flip p-value",
    "wilcoxon_w_min": wilcoxon_threshold_exact["w_min"],
    "wilcoxon_t_plus": wilcoxon_threshold_exact["t_plus"],
    "wilcoxon_t_minus": wilcoxon_threshold_exact["t_minus"],
    "wilcoxon_n_nonzero": wilcoxon_threshold_exact["n_nonzero"],
    "wilcoxon_exact_p": wilcoxon_threshold_exact["exact_two_sided_p"],
    "wilcoxon_approx_p": float(wilcoxon_threshold_approx.pvalue),
    "wilcoxon_approx_z": float(getattr(wilcoxon_threshold_approx, "zstatistic", np.nan)),
    "rank_biserial": wilcoxon_threshold_exact["rank_biserial"],
    "paired_t": float(t_threshold.statistic),
    "paired_t_df": 24,
    "paired_t_p": float(t_threshold.pvalue),
    "cohen_dz": float(analysis["delta"].mean() / analysis["delta"].std(ddof=1)),
    "sign_test_p": float(sign_threshold.pvalue),
}

direction_summary = (
    analysis["change_direction"]
    .value_counts()
    .reindex(["Increase", "Decrease", "Unchanged"], fill_value=0)
    .rename_axis("direction")
    .reset_index(name="n")
)
direction_summary["percent"] = direction_summary["n"] / len(analysis) * 100

decision_summary = analysis["decision"].value_counts().rename_axis("decision").reset_index(name="n")
decision_summary["percent"] = decision_summary["n"] / len(analysis) * 100

nonzero_delta = analysis.loc[analysis["delta"].ne(0), "delta"]
change_magnitude = {
    "numerical_revisers": int(nonzero_delta.size),
    "median_abs_change": float(nonzero_delta.abs().median()),
    "mean_abs_change": float(nonzero_delta.abs().mean()),
    "positive_n": int((nonzero_delta > 0).sum()),
    "positive_median": float(nonzero_delta.loc[nonzero_delta > 0].median()),
    "negative_n": int((nonzero_delta < 0).sum()),
    "negative_median_abs": float(nonzero_delta.loc[nonzero_delta < 0].abs().median()),
}

view_summary_rows = []
for view_id, group in analysis.groupby("view_id"):
    view_summary_rows.append(
        {
            "view_id": view_id,
            "n": int(len(group)),
            "pre_mean": float(group["pre_threshold"].mean()),
            "pre_median": float(group["pre_threshold"].median()),
            "post_mean": float(group["post_threshold"].mean()),
            "post_median": float(group["post_threshold"].median()),
            "delta_mean": float(group["delta"].mean()),
            "delta_median": float(group["delta"].median()),
            "increase_n": int((group["delta"] > 0).sum()),
            "decrease_n": int((group["delta"] < 0).sum()),
            "unchanged_n": int((group["delta"] == 0).sum()),
            "revise_n": int(group["decision"].eq("REVISE").sum()),
        }
    )
view_summary = pd.DataFrame(view_summary_rows).sort_values("view_id")

extreme_changes = analysis.loc[
    analysis["delta"].ne(0),
    ["analysis_id", "view_id", "pre_threshold", "post_threshold", "delta", "decision", "pre_confidence", "post_confidence"],
].copy()
extreme_changes["absolute_delta"] = extreme_changes["delta"].abs()
extreme_changes = extreme_changes.sort_values(["absolute_delta", "delta"], ascending=[False, True])

# Confidence is ordinal: paired Wilcoxon is primary.
confidence_stats = {
    "pre": descriptive(analysis["pre_confidence"]),
    "post": descriptive(analysis["post_confidence"]),
    "delta": descriptive(analysis["confidence_delta"]),
}
wilcoxon_confidence_approx = stats.wilcoxon(
    analysis["confidence_delta"], zero_method="wilcox", correction=False, alternative="two-sided", method="approx"
)
wilcoxon_confidence_exact = exact_signed_rank(analysis["confidence_delta"])
confidence_tests = {
    "wilcoxon_w_min": wilcoxon_confidence_exact["w_min"],
    "wilcoxon_t_plus": wilcoxon_confidence_exact["t_plus"],
    "wilcoxon_t_minus": wilcoxon_confidence_exact["t_minus"],
    "wilcoxon_n_nonzero": wilcoxon_confidence_exact["n_nonzero"],
    "wilcoxon_exact_p": wilcoxon_confidence_exact["exact_two_sided_p"],
    "wilcoxon_approx_p": float(wilcoxon_confidence_approx.pvalue),
    "wilcoxon_approx_z": float(getattr(wilcoxon_confidence_approx, "zstatistic", np.nan)),
    "rank_biserial": wilcoxon_confidence_exact["rank_biserial"],
    "increase_n": int((analysis["confidence_delta"] > 0).sum()),
    "decrease_n": int((analysis["confidence_delta"] < 0).sum()),
    "unchanged_n": int((analysis["confidence_delta"] == 0).sum()),
}
confidence_transition = pd.crosstab(
    analysis["pre_confidence"], analysis["post_confidence"], dropna=False
).reindex(index=range(1, 8), columns=range(1, 8), fill_value=0)

feasibility_stats = descriptive(analysis["feasibility"])
feasibility_by_decision = (
    analysis.groupby("decision")["feasibility"]
    .agg(n="count", mean="mean", median="median", sd="std", min="min", max="max")
    .reset_index()
)

# Comprehension summaries.
question_first_pass = (
    first_attempt.groupby("question_id")["correct"]
    .agg(first_attempt_n="count", first_correct_n="sum")
    .reset_index()
)
question_first_pass["first_correct_percent"] = (
    question_first_pass["first_correct_n"] / question_first_pass["first_attempt_n"] * 100
)
comprehension_summary = {
    "participants_all_correct_first_attempt": int(analysis["first_pass_all"].sum()),
    "participants_requiring_retry": int((analysis["retry_count"] > 0).sum()),
    "additional_attempts": int(analysis["retry_count"].sum()),
    "first_attempt_answers_correct": int(first_attempt["correct"].sum()),
    "first_attempt_answers_total": int(len(first_attempt)),
    "participants_final_correct": int(analysis["final_pass_all"].sum()),
    "max_attempt_number": int(comp["attempt_no"].max()),
}

# SUS summary and internal consistency (supplementary, not required for the main RQ).
sus_stats = descriptive(analysis["sus_score"])
sus_ci_low, sus_ci_high = mean_ci95(analysis["sus_score"])
sus_stats["mean_ci95_low"] = sus_ci_low
sus_stats["mean_ci95_high"] = sus_ci_high
item_variances = sus_scored.var(axis=0, ddof=1)
total_variance = sus_scored.sum(axis=1).var(ddof=1)
sus_alpha = (10 / 9) * (1 - item_variances.sum() / total_variance)
sus_stats["cronbach_alpha_scored_items"] = float(sus_alpha)

sus_participant = analysis[["analysis_id", "participant_id", "session_id"] + [f"sus_item_{i}" for i in range(1, 11)] + ["sus_score"]].copy()

# NASA-TLX by dimension. Performance is explicitly labelled opposite-direction.
nasa_order = ["mental", "physical", "temporal", "performance", "effort", "frustration"]
nasa_labels = {
    "mental": "Mental Demand",
    "physical": "Physical Demand",
    "temporal": "Temporal Demand",
    "performance": "Performance (higher = greater success)",
    "effort": "Effort",
    "frustration": "Frustration",
}
nasa_summary_rows = []
for key in nasa_order:
    col = f"nasa_{key}"
    desc = descriptive(analysis[col])
    ci_low, ci_high = mean_ci95(analysis[col])
    nasa_summary_rows.append(
        {
            "item_key": key,
            "dimension": nasa_labels[key],
            "direction": "Higher = greater perceived success" if key == "performance" else "Higher = greater burden",
            **desc,
            "mean_ci95_low": ci_low,
            "mean_ci95_high": ci_high,
        }
    )
nasa_summary = pd.DataFrame(nasa_summary_rows)
nasa_participant = analysis[["analysis_id", "participant_id", "session_id"] + [f"nasa_{x}" for x in nasa_order] + ["nasa_burden_mean_excl_performance"]].copy()

# Exploratory cross-measure coherence, Holm-adjusted across seven SUS/TLX correlations.
correlation_targets = burden_dimensions + ["nasa_performance", "nasa_burden_mean_excl_performance"]
correlation_rows = []
for col in correlation_targets:
    rho, p_value = stats.spearmanr(analysis["sus_score"], analysis[col])
    correlation_rows.append(
        {
            "x": "sus_score",
            "y": col,
            "spearman_rho": float(rho),
            "p_unadjusted": float(p_value),
        }
    )
adjusted = holm_adjust([row["p_unadjusted"] for row in correlation_rows])
for row, adjusted_p in zip(correlation_rows, adjusted):
    row["p_holm"] = adjusted_p
cross_measure_correlations = pd.DataFrame(correlation_rows)

# ---------------------------- Outlier audit ----------------------------
outlier_fields = [
    "pre_threshold",
    "post_threshold",
    "delta",
    "pre_decision_ms",
    "post_decision_ms",
    "sus_score",
] + [f"nasa_{x}" for x in nasa_order]
outlier_rows = []
for field in outlier_fields:
    series = analysis[field].astype(float)
    q1, q3 = series.quantile(0.25), series.quantile(0.75)
    iqr = q3 - q1
    low, high = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    flags = analysis.loc[(series < low) | (series > high), ["analysis_id", "participant_id", field]]
    for _, row in flags.iterrows():
        outlier_rows.append(
            {
                "analysis_id": row["analysis_id"],
                "participant_id": row["participant_id"],
                "field": field,
                "value": float(row[field]),
                "iqr_lower_fence": float(low),
                "iqr_upper_fence": float(high),
                "assessment": "Valid-range statistical outlier; retained unless an independent protocol violation is found.",
            }
        )
outlier_audit = pd.DataFrame(outlier_rows)

# ---------------------------- Qualitative coding ----------------------------
# Primary categories are mutually exclusive; concept tags can overlap.
with args.coding.open(newline="", encoding="utf-8") as handle:
    qual_codes = {row["participant_id"]: (row["primary_theme"], row["concept_tags"]) for row in csv.DictReader(handle)}

submitted_qual_ids = set(
    analysis.loc[analysis["qualitative_skipped"].eq(0), "participant_id"].tolist()
)
assert submitted_qual_ids == set(qual_codes), "Qualitative code map must match all submitted texts exactly."
qualitative_coding = analysis.loc[
    analysis["qualitative_skipped"].eq(0),
    [
        "analysis_id",
        "participant_id",
        "view_id",
        "decision",
        "pre_threshold",
        "post_threshold",
        "delta",
        "qualitative_text",
    ],
].copy()
qualitative_coding[["primary_theme", "concept_tags"]] = qualitative_coding["participant_id"].apply(
    lambda participant_id: pd.Series(qual_codes[participant_id])
)
theme_order = [
    "Relaxed to preserve accuracy/practicality",
    "Tightened because lower disparity remained accurate",
    "Initial judgement reaffirmed",
    "Retained due feasibility uncertainty",
]
qualitative_theme_summary = (
    qualitative_coding["primary_theme"]
    .value_counts()
    .reindex(theme_order, fill_value=0)
    .rename_axis("primary_theme")
    .reset_index(name="n")
)
qualitative_theme_summary["percent_of_text_respondents"] = qualitative_theme_summary["n"] / len(qualitative_coding) * 100

# ---------------------------- Publication figures ----------------------------
sns.set_theme(style="whitegrid", context="paper")
plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 10,
        "axes.titlesize": 12,
        "axes.labelsize": 10,
        "figure.dpi": 150,
    }
)

# Figure 1: Fairness View distribution.
view_counts = analysis["view_id"].value_counts().reindex(["C01", "C02", "C04"])
fig, ax = plt.subplots(figsize=(6.2, 4.0))
bars = ax.bar(view_counts.index, view_counts.values, color=["#4C78A8", "#72B7B2", "#F2CF5B"], width=0.62)
ax.set_title("Selected Fairness Views")
ax.set_xlabel("Fairness View")
ax.set_ylabel("Participants (n)")
ax.set_ylim(0, max(view_counts.values) + 2)
ax.bar_label(bars, labels=[f"{n} ({n/25:.0%})" for n in view_counts.values], padding=3)
ax.grid(axis="x", visible=False)
sns.despine(ax=ax)
fig.tight_layout()
save_figure(fig, "figure_1_fairness_view_distribution")

# Figure 2: paired thresholds plus participant-level deltas.
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11.0, 6.2), gridspec_kw={"width_ratios": [0.85, 1.15]})
direction_colors = {"Increase": "#2A9D8F", "Decrease": "#D1495B", "Unchanged": "#8C8C8C"}
for _, row in analysis.iterrows():
    color = direction_colors[row["change_direction"]]
    ax1.plot([0, 1], [row["pre_threshold"], row["post_threshold"]], color=color, alpha=0.62, linewidth=1.5)
    ax1.scatter([0, 1], [row["pre_threshold"], row["post_threshold"]], color=color, s=28, zorder=3)
ax1.set_xticks([0, 1], ["PRE", "POST"])
ax1.set_xlim(-0.3, 1.3)
ax1.set_ylim(0, 90)
ax1.set_ylabel("Fairness tolerance threshold (percentage points)")
ax1.set_title("A. Paired PRE–POST thresholds")
ax1.grid(axis="x", visible=False)

delta_plot = analysis.sort_values(["delta", "analysis_id"]).reset_index(drop=True)
y = np.arange(len(delta_plot))
colors = [direction_colors[d] for d in delta_plot["change_direction"]]
ax2.hlines(y, 0, delta_plot["delta"], color=colors, linewidth=2)
ax2.scatter(delta_plot["delta"], y, color=colors, s=34, zorder=3)
ax2.axvline(0, color="#333333", linewidth=1)
ax2.set_yticks(y, delta_plot["analysis_id"])
ax2.set_xlabel("Threshold delta (POST − PRE, percentage points)")
ax2.set_title("B. Participant-level change")
ax2.grid(axis="y", visible=False)
from matplotlib.lines import Line2D

legend = [Line2D([0], [0], color=color, lw=2, marker="o", label=label) for label, color in direction_colors.items()]
ax2.legend(handles=legend, loc="lower right", frameon=False)
sns.despine(ax=ax1)
sns.despine(ax=ax2)
fig.tight_layout()
save_figure(fig, "figure_2_threshold_pre_post_and_delta")

# Figure 3: direction counts.
fig, ax = plt.subplots(figsize=(6.4, 4.0))
bars = ax.bar(
    direction_summary["direction"],
    direction_summary["n"],
    color=[direction_colors[x] for x in direction_summary["direction"]],
    width=0.62,
)
ax.bar_label(bars, labels=[f"{n} ({n/25:.0%})" for n in direction_summary["n"]], padding=3)
ax.set_title("Direction of Threshold Change")
ax.set_xlabel("")
ax.set_ylabel("Participants (n)")
ax.set_ylim(0, max(direction_summary["n"]) + 3)
ax.grid(axis="x", visible=False)
sns.despine(ax=ax)
fig.tight_layout()
save_figure(fig, "figure_3_threshold_change_direction")

# Figure 4: confidence transition matrix.
fig, ax = plt.subplots(figsize=(6.2, 5.2))
confidence_transition_plot = confidence_transition.loc[2:6, 3:6]
sns.heatmap(
    confidence_transition_plot,
    annot=True,
    fmt="d",
    cmap=sns.light_palette("#4C78A8", as_cmap=True),
    mask=confidence_transition_plot.eq(0),
    cbar=False,
    square=True,
    linewidths=0.6,
    linecolor="white",
    ax=ax,
)
ax.set_title("PRE–POST Confidence Transitions")
ax.set_xlabel("POST confidence (1–7)")
ax.set_ylabel("PRE confidence (1–7)")
fig.tight_layout()
save_figure(fig, "figure_4_confidence_transition")

# Figure 5: SUS distribution with common benchmark marked for later citation.
fig, ax = plt.subplots(figsize=(7.2, 3.8))
y_jitter = np.linspace(-0.05, 0.05, len(analysis))
ax.scatter(analysis["sus_score"], y_jitter, color="#4C78A8", alpha=0.78, s=38, edgecolor="white", linewidth=0.4)
ax.boxplot(
    analysis["sus_score"],
    orientation="horizontal",
    positions=[0.22],
    widths=0.12,
    patch_artist=True,
    boxprops={"facecolor": "#DCEAF7", "edgecolor": "#4C78A8"},
    medianprops={"color": "#1F3A5F", "linewidth": 1.8},
    whiskerprops={"color": "#4C78A8"},
    capprops={"color": "#4C78A8"},
    flierprops={"marker": ""},
)
ax.axvline(68, color="#D1495B", linestyle="--", linewidth=1.4, label="Global SUS benchmark: 68")
ax.set_xlim(0, 100)
ax.set_ylim(-0.12, 0.38)
ax.set_yticks([])
ax.set_xlabel("SUS score (0–100)")
ax.set_title("Distribution of System Usability Scale Scores")
ax.legend(loc="upper left", frameon=False, fontsize=8)
ax.grid(axis="y", visible=False)
sns.despine(ax=ax, left=True)
fig.tight_layout()
save_figure(fig, "figure_5_sus_distribution")

# Figure 6: NASA-TLX dimension means with 95% confidence intervals.
fig, ax = plt.subplots(figsize=(8.2, 4.8))
plot_df = nasa_summary.copy()
x = np.arange(len(plot_df))
colors = ["#59A14F" if key == "performance" else "#4C78A8" for key in plot_df["item_key"]]
errors = np.vstack(
    [
        plot_df["mean"] - plot_df["mean_ci95_low"],
        plot_df["mean_ci95_high"] - plot_df["mean"],
    ]
)
for idx, (mean_value, low_error, high_error, color) in enumerate(
    zip(plot_df["mean"], errors[0], errors[1], colors)
):
    ax.errorbar(
        idx,
        mean_value,
        yerr=np.array([[low_error], [high_error]]),
        fmt="none",
        ecolor=color,
        elinewidth=1.6,
        capsize=4,
    )
ax.scatter(x, plot_df["mean"], color=colors, s=72, zorder=3)
ax.set_xticks(x, ["Mental", "Physical", "Temporal", "Performance*", "Effort", "Frustration"], rotation=18, ha="right")
ax.set_ylabel("Mean rating (0–100; 95% CI)")
ax.set_ylim(0, 100)
ax.set_title("Raw NASA-TLX Dimensions")
ax.text(
    0.01,
    -0.25,
    "*Performance was administered in the opposite direction: higher values indicate greater perceived success; all other dimensions indicate greater burden.",
    transform=ax.transAxes,
    ha="left",
    va="top",
    fontsize=8,
)
ax.grid(axis="x", visible=False)
sns.despine(ax=ax)
fig.subplots_adjust(bottom=0.28)
save_figure(fig, "figure_6_nasa_tlx_dimensions")

# Figure 7 (optional): qualitative primary themes among respondents who supplied text.
fig, ax = plt.subplots(figsize=(8.0, 4.4))
theme_plot = qualitative_theme_summary.iloc[::-1]
bars = ax.barh(theme_plot["primary_theme"], theme_plot["n"], color="#6F4E7C")
ax.bar_label(bars, labels=[f"{n} ({n/12:.0%})" for n in theme_plot["n"]], padding=3)
ax.set_xlim(0, max(theme_plot["n"]) + 1.4)
ax.set_xlabel("Text respondents (n; denominator = 12)")
ax.set_title("Primary Themes in Optional Qualitative Responses")
ax.grid(axis="y", visible=False)
sns.despine(ax=ax)
fig.tight_layout()
save_figure(fig, "figure_7_qualitative_themes_optional")

# Supplementary diagnostic: the zero-inflated, discrete delta distribution and Q-Q pattern.
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(9.0, 3.8))
delta_counts = analysis["delta"].value_counts().sort_index()
ax1.bar(delta_counts.index.astype(str), delta_counts.values, color="#7A8FA6")
ax1.set_title("Observed threshold deltas")
ax1.set_xlabel("POST − PRE (percentage points)")
ax1.set_ylabel("Participants (n)")
ax1.tick_params(axis="x", rotation=35)
stats.probplot(analysis["delta"], dist="norm", plot=ax2)
ax2.set_title("Normal Q–Q plot of paired differences")
ax2.get_lines()[0].set_markerfacecolor("#4C78A8")
ax2.get_lines()[0].set_markeredgecolor("#4C78A8")
ax2.get_lines()[1].set_color("#D1495B")
sns.despine(ax=ax1)
sns.despine(ax=ax2)
fig.tight_layout()
save_figure(fig, "supplementary_delta_normality_diagnostic")

# ---------------------------- Export analysis tables ----------------------------
analysis.to_csv(WORK_OUT / "participant_analysis.csv", index=False)
table_inventory.to_csv(WORK_OUT / "table_inventory.csv", index=False)
data_quality.to_csv(WORK_OUT / "data_quality.csv", index=False)
decision_inconsistent.to_csv(WORK_OUT / "decision_delta_inconsistency.csv", index=False)
outlier_audit.to_csv(WORK_OUT / "outlier_audit.csv", index=False)
direction_summary.to_csv(WORK_OUT / "direction_summary.csv", index=False)
decision_summary.to_csv(WORK_OUT / "decision_summary.csv", index=False)
view_summary.to_csv(WORK_OUT / "fairness_view_summary.csv", index=False)
extreme_changes.to_csv(WORK_OUT / "extreme_changes.csv", index=False)
confidence_transition.to_csv(WORK_OUT / "confidence_transition.csv")
question_first_pass.to_csv(WORK_OUT / "comprehension_by_question.csv", index=False)
feasibility_by_decision.to_csv(WORK_OUT / "feasibility_by_decision.csv", index=False)
sus_participant.to_csv(WORK_OUT / "sus_participant.csv", index=False)
nasa_participant.to_csv(WORK_OUT / "nasa_participant.csv", index=False)
nasa_summary.to_csv(WORK_OUT / "nasa_summary.csv", index=False)
cross_measure_correlations.to_csv(WORK_OUT / "cross_measure_correlations.csv", index=False)
qualitative_coding.to_csv(WORK_OUT / "qualitative_coding.csv", index=False)
qualitative_theme_summary.to_csv(WORK_OUT / "qualitative_theme_summary.csv", index=False)

result = {
    "provenance": {
        "source_file_name": "study_final.sqlite",
        "analysis_copy": DB_PATH.name,
        "sha256": db_hash,
        "sqlite_integrity": integrity_result,
        "analysis_note": "Database opened with mode=ro, immutable=1, and PRAGMA query_only=ON; original attachment not modified.",
    },
    "data_quality": records(data_quality),
    "table_inventory": records(table_inventory),
    "threshold_stats": threshold_stats,
    "threshold_tests": threshold_tests,
    "direction_summary": records(direction_summary),
    "decision_summary": records(decision_summary),
    "change_magnitude": change_magnitude,
    "view_summary": records(view_summary),
    "decision_inconsistency": records(decision_inconsistent),
    "extreme_changes": records(extreme_changes),
    "confidence_stats": confidence_stats,
    "confidence_tests": confidence_tests,
    "feasibility_stats": feasibility_stats,
    "feasibility_by_decision": records(feasibility_by_decision),
    "comprehension_summary": comprehension_summary,
    "comprehension_by_question": records(question_first_pass),
    "sus_stats": sus_stats,
    "nasa_summary": records(nasa_summary),
    "cross_measure_correlations": records(cross_measure_correlations),
    "outlier_audit": records(outlier_audit),
    "qualitative_summary": {
        "submitted_n": int(len(qualitative_coding)),
        "skipped_n": int(analysis["qualitative_skipped"].eq(1).sum()),
        "keep_text_n": int(qualitative_coding["decision"].eq("KEEP").sum()),
        "revise_text_n": int(qualitative_coding["decision"].eq("REVISE").sum()),
        "themes": records(qualitative_theme_summary),
    },
}

(WORK_OUT / "analysis_results.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
workbook_data = {
    "analysis_results": result,
    "participant_analysis": records(analysis),
    "data_quality": records(data_quality),
    "table_inventory": records(table_inventory),
    "outlier_audit": records(outlier_audit),
    "decision_inconsistency": records(decision_inconsistent),
    "direction_summary": records(direction_summary),
    "decision_summary": records(decision_summary),
    "view_summary": records(view_summary),
    "extreme_changes": records(extreme_changes),
    "confidence_transition": records(confidence_transition.reset_index()),
    "comprehension_by_question": records(question_first_pass),
    "feasibility_by_decision": records(feasibility_by_decision),
    "sus_participant": records(sus_participant),
    "nasa_participant": records(nasa_participant),
    "nasa_summary": records(nasa_summary),
    "cross_measure_correlations": records(cross_measure_correlations),
    "qualitative_coding": records(qualitative_coding),
    "qualitative_theme_summary": records(qualitative_theme_summary),
}
(WORK_OUT / "workbook_data.json").write_text(
    json.dumps(workbook_data, indent=2, ensure_ascii=False), encoding="utf-8"
)
conn.close()

print(json.dumps(result, indent=2, ensure_ascii=False))
