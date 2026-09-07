#!/usr/bin/env python3
"""Generate and validate the nine frozen fairness/accuracy candidates.

This pipeline consumes only the fixed predictions committed by Lin Luo. It never
trains, fits, tunes, or calls a model. All participant-facing files deliberately
omit the model classification cutoff.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from statistics import pstdev
from typing import Any, Iterable, Sequence


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "src" / "data" / "results.json"
DEFAULT_PROTOCOL = ROOT / "research" / "validation_protocol.json"
DEFAULT_OUTPUT = ROOT / "research" / "generated"

METRIC_LABELS = {
    "demographic_parity": "Demographic Parity",
    "equal_opportunity": "Equal Opportunity",
    "equalized_odds": "Equalized Odds",
}


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    group_key: str
    group_label: str
    group_a: str
    group_b: str
    metric: str


CANDIDATES = (
    Candidate("C01", "dataset_coded_sex", "Dataset-coded Sex", "Female", "Male", "demographic_parity"),
    Candidate("C02", "dataset_coded_sex", "Dataset-coded Sex", "Female", "Male", "equal_opportunity"),
    Candidate("C03", "dataset_coded_sex", "Dataset-coded Sex", "Female", "Male", "equalized_odds"),
    Candidate("C04", "age_25", "Age", "Age <= 25", "Age > 25", "demographic_parity"),
    Candidate("C05", "age_25", "Age", "Age <= 25", "Age > 25", "equal_opportunity"),
    Candidate("C06", "age_25", "Age", "Age <= 25", "Age > 25", "equalized_odds"),
    Candidate("C07", "foreign_worker", "Foreign Worker", "No", "Yes", "demographic_parity"),
    Candidate("C08", "foreign_worker", "Foreign Worker", "No", "Yes", "equal_opportunity"),
    Candidate("C09", "foreign_worker", "Foreign Worker", "No", "Yes", "equalized_odds"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cutoff_grid(protocol: dict[str, Any]) -> list[float]:
    start = int(round(float(protocol["cutoff_start"]) * 100))
    stop = int(round(float(protocol["cutoff_stop"]) * 100))
    step = int(round(float(protocol["cutoff_step"]) * 100))
    return [value / 100 for value in range(start, stop + 1, step)]


def normalize_rows(raw_rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for raw in raw_rows:
        sample_id = int(raw["id"])
        if sample_id in seen_ids:
            raise ValueError(f"duplicate sample id: {sample_id}")
        seen_ids.add(sample_id)
        probabilities = raw.get("Probability")
        if not isinstance(probabilities, list) or len(probabilities) != 2:
            raise ValueError(f"sample {sample_id} has no two-class Probability value")
        bad_score, good_score = (float(probabilities[0]), float(probabilities[1]))
        if not (0 <= bad_score <= 1 and 0 <= good_score <= 1):
            raise ValueError(f"sample {sample_id} has a probability outside [0, 1]")
        if not math.isclose(bad_score + good_score, 1.0, abs_tol=0.011):
            raise ValueError(f"sample {sample_id} probabilities do not sum to one")
        label = raw.get("Real Credit")
        if label not in {"Good", "Bad"}:
            raise ValueError(f"sample {sample_id} has an unsupported label: {label}")
        gender = raw.get("Gender")
        foreign_worker = raw.get("Foreign Worker")
        if gender not in {"Female", "Male"}:
            raise ValueError(f"sample {sample_id} has an unsupported Gender value")
        if foreign_worker not in {"No", "Yes"}:
            raise ValueError(f"sample {sample_id} has an unsupported Foreign Worker value")
        age = int(raw["Age"])
        rows.append(
            {
                "sample_id": sample_id,
                "y_true": 1 if label == "Good" else 0,
                "y_score": good_score,
                "dataset_coded_sex": gender,
                "age_25": "Age <= 25" if age <= 25 else "Age > 25",
                "foreign_worker": foreign_worker,
            }
        )
    if not rows:
        raise ValueError("prediction asset is empty")
    return rows


def rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def group_stats(rows: Sequence[dict[str, Any]], candidate: Candidate, cutoff: float) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for group in (candidate.group_a, candidate.group_b):
        subset = [row for row in rows if row[candidate.group_key] == group]
        tp = sum(row["y_true"] == 1 and row["y_score"] >= cutoff for row in subset)
        fp = sum(row["y_true"] == 0 and row["y_score"] >= cutoff for row in subset)
        tn = sum(row["y_true"] == 0 and row["y_score"] < cutoff for row in subset)
        fn = sum(row["y_true"] == 1 and row["y_score"] < cutoff for row in subset)
        result[group] = {
            "n": len(subset),
            "positive_n": tp + fn,
            "negative_n": fp + tn,
            "tp": tp,
            "fp": fp,
            "tn": tn,
            "fn": fn,
            "selection_rate": rate(tp + fp, len(subset)),
            "tpr": rate(tp, tp + fn),
            "fpr": rate(fp, fp + tn),
        }
    return result


def disparity(metric: str, stats: dict[str, dict[str, Any]], group_a: str, group_b: str) -> float | None:
    a, b = stats[group_a], stats[group_b]
    if metric == "demographic_parity":
        values = (a["selection_rate"], b["selection_rate"])
        return None if None in values else abs(values[0] - values[1]) * 100
    if metric == "equal_opportunity":
        values = (a["tpr"], b["tpr"])
        return None if None in values else abs(values[0] - values[1]) * 100
    if metric == "equalized_odds":
        tprs = (a["tpr"], b["tpr"])
        fprs = (a["fpr"], b["fpr"])
        if None in tprs or None in fprs:
            return None
        return max(abs(tprs[0] - tprs[1]), abs(fprs[0] - fprs[1])) * 100
    raise ValueError(f"unsupported metric: {metric}")


def accuracy(rows: Sequence[dict[str, Any]], cutoff: float) -> float:
    correct = sum((row["y_score"] >= cutoff) == bool(row["y_true"]) for row in rows)
    return correct / len(rows) * 100


def critical_denominators(rows: Sequence[dict[str, Any]], candidate: Candidate) -> tuple[int, int, int]:
    counts: dict[str, dict[str, int]] = {}
    for group in (candidate.group_a, candidate.group_b):
        subset = [row for row in rows if row[candidate.group_key] == group]
        counts[group] = {
            "all": len(subset),
            "positive": sum(row["y_true"] == 1 for row in subset),
            "negative": sum(row["y_true"] == 0 for row in subset),
        }
    if candidate.metric == "demographic_parity":
        relevant = [counts[group]["all"] for group in counts]
    elif candidate.metric == "equal_opportunity":
        relevant = [counts[group]["positive"] for group in counts]
    else:
        relevant = [counts[group][key] for group in counts for key in ("positive", "negative")]
    return min(relevant), counts[candidate.group_a]["all"], counts[candidate.group_b]["all"]


def bootstrap_stability(
    rows: Sequence[dict[str, Any]],
    candidate: Candidate,
    cutoffs: Sequence[float],
    replicates: int,
    seed: int,
) -> tuple[float, float]:
    rng = random.Random(seed + int(candidate.candidate_id[1:]))
    values_by_cutoff: list[list[float]] = [[] for _ in cutoffs]
    for _ in range(replicates):
        sample = [rows[rng.randrange(len(rows))] for _ in rows]
        for index, cutoff in enumerate(cutoffs):
            stats = group_stats(sample, candidate, cutoff)
            value = disparity(candidate.metric, stats, candidate.group_a, candidate.group_b)
            if value is not None:
                values_by_cutoff[index].append(value)
    sds = [pstdev(values) for values in values_by_cutoff if len(values) >= 2]
    valid_fraction = min((len(values) / replicates for values in values_by_cutoff), default=0.0)
    return (max(sds, default=float("inf")), valid_fraction)


def point_row(rows: Sequence[dict[str, Any]], candidate: Candidate, cutoff: float) -> dict[str, Any]:
    stats = group_stats(rows, candidate, cutoff)
    value = disparity(candidate.metric, stats, candidate.group_a, candidate.group_b)
    valid = value is not None
    a, b = stats[candidate.group_a], stats[candidate.group_b]
    return {
        "candidate_id": candidate.candidate_id,
        "group_key": candidate.group_key,
        "group_label": candidate.group_label,
        "group_a": candidate.group_a,
        "group_b": candidate.group_b,
        "metric": candidate.metric,
        "metric_label": METRIC_LABELS[candidate.metric],
        "classification_cutoff": f"{cutoff:.2f}",
        "accuracy_pp": f"{accuracy(rows, cutoff):.4f}",
        "fairness_disparity_pp": "" if value is None else f"{value:.4f}",
        "group_a_n": a["n"],
        "group_b_n": b["n"],
        "group_a_positive_n": a["positive_n"],
        "group_b_positive_n": b["positive_n"],
        "group_a_negative_n": a["negative_n"],
        "group_b_negative_n": b["negative_n"],
        "group_a_tp": a["tp"],
        "group_a_fp": a["fp"],
        "group_a_tn": a["tn"],
        "group_a_fn": a["fn"],
        "group_b_tp": b["tp"],
        "group_b_fp": b["fp"],
        "group_b_tn": b["tn"],
        "group_b_fn": b["fn"],
        "group_a_selection_rate": "" if a["selection_rate"] is None else f"{a['selection_rate']:.6f}",
        "group_b_selection_rate": "" if b["selection_rate"] is None else f"{b['selection_rate']:.6f}",
        "group_a_tpr": "" if a["tpr"] is None else f"{a['tpr']:.6f}",
        "group_b_tpr": "" if b["tpr"] is None else f"{b['tpr']:.6f}",
        "group_a_fpr": "" if a["fpr"] is None else f"{a['fpr']:.6f}",
        "group_b_fpr": "" if b["fpr"] is None else f"{b['fpr']:.6f}",
        "point_valid": str(valid).lower(),
        "invalid_reason": "" if valid else "undefined metric denominator",
    }


def write_csv(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    if not rows:
        raise ValueError(f"refusing to write empty CSV: {path}")
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def select_active(summary: list[dict[str, Any]], protocol: dict[str, Any]) -> list[str]:
    eligible = [row for row in summary if row["eligible"]]
    selected: list[dict[str, Any]] = []
    by_id = {row["candidate_id"]: row for row in eligible}
    for candidate_id in protocol["priority_candidates"]:
        if candidate_id in by_id and len(selected) < int(protocol["active_view_count"]):
            selected.append(by_id[candidate_id])
    complexity = {"demographic_parity": 1, "equal_opportunity": 2, "equalized_odds": 3}
    while len(selected) < int(protocol["active_view_count"]):
        remaining = [row for row in eligible if row not in selected]
        if not remaining:
            break
        groups = {row["group_key"] for row in selected}
        metrics = {row["metric"] for row in selected}
        remaining.sort(
            key=lambda row: (
                -int(row["group_key"] not in groups),
                -int(row["metric"] not in metrics),
                -int(row["critical_denominator_min"]),
                float(row["bootstrap_max_sd_pp"]),
                complexity[row["metric"]],
                row["candidate_id"],
            )
        )
        selected.append(remaining[0])
    return [row["candidate_id"] for row in selected]


def participant_content(
    active_ids: Sequence[str], points: Sequence[dict[str, Any]], candidates: Sequence[Candidate]
) -> dict[str, Any]:
    candidate_map = {candidate.candidate_id: candidate for candidate in candidates}
    content: list[dict[str, Any]] = []
    descriptions = {
        "demographic_parity": "Compares how often the two groups receive a Good Credit prediction.",
        "equal_opportunity": "Among people actually rated Good Credit, compares how often each group receives a Good Credit prediction.",
        "equalized_odds": "Compares both correct Good Credit predictions and incorrect Good Credit predictions between the groups.",
    }
    for active_id in active_ids:
        candidate = candidate_map[active_id]
        candidate_points = [row for row in points if row["candidate_id"] == active_id and row["point_valid"] == "true"]
        sampled = [row for row in candidate_points if int(round(float(row["classification_cutoff"]) * 100)) % 5 == 0]
        seen: set[tuple[str, str]] = set()
        public_points: list[dict[str, Any]] = []
        for row in sampled:
            coordinate = (row["accuracy_pp"], row["fairness_disparity_pp"])
            if coordinate in seen:
                continue
            seen.add(coordinate)
            opaque = hashlib.sha256(f"{active_id}:{row['classification_cutoff']}".encode()).hexdigest()[:8].upper()
            public_points.append(
                {
                    "model_config_id": f"MC-{opaque}",
                    "accuracy_pp": round(float(row["accuracy_pp"]), 2),
                    "fairness_disparity_pp": round(float(row["fairness_disparity_pp"]), 2),
                }
            )
        content.append(
            {
                "view_id": active_id,
                "title": f"{candidate.group_label} x {METRIC_LABELS[candidate.metric]}",
                "group_key": candidate.group_key,
                "group_label": candidate.group_label,
                "group_a": candidate.group_a,
                "group_b": candidate.group_b,
                "metric": candidate.metric,
                "metric_label": METRIC_LABELS[candidate.metric],
                "description": descriptions[candidate.metric],
                "points": public_points,
            }
        )
    return {
        "content_version": "1.2.0-frozen-2026-08-13",
        "tradeoff_dataset_version": "lin-luo-fixed-test-200-v1.0.0",
        "units": "percentage points (0-100)",
        "positive_outcome": "Good Credit",
        "utility": "Accuracy is a simplified, interpretable proxy for model utility.",
        "classification_cutoff_exposed": False,
        "active_views": content,
    }


def codebook_text() -> str:
    return """# Offline validation output codebook

All fairness and accuracy values use percentage points on a 0-100 scale. `Good Credit` is the positive label.

- `tradeoff_points.csv`: researcher-side results for every candidate and fixed classification cutoff. Cutoff is technical provenance and must never be returned by participant APIs.
- `candidate_summary.csv`: one row per candidate with frozen validation gates, bootstrap stability, selection status, and reason.
- `validation_report.csv`: one row per validation check and candidate.
- `participant_tradeoff.json`: frozen participant content for Active Views. It contains only disparity, accuracy, and opaque model configuration IDs.
- `manifest.json`: versions, protocol, input/output hashes, selection rule, and provenance warning.

Metric definitions:

- Demographic Parity disparity: absolute difference in Good Credit prediction rates between groups.
- Equal Opportunity disparity: absolute difference in true-positive rates between groups.
- Equalized Odds disparity: maximum of the absolute true-positive-rate gap and false-positive-rate gap.

The source repository labels the committed 200 records as test data after model training. No training code or split-generation provenance was published with the asset, so the manifest records that limitation rather than overstating it as OOF data.
"""


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--protocol", type=Path, default=DEFAULT_PROTOCOL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    protocol = json.loads(args.protocol.read_text(encoding="utf-8"))
    raw_rows = json.loads(args.input.read_text(encoding="utf-8"))
    rows = normalize_rows(raw_rows)
    cutoffs = cutoff_grid(protocol)
    args.output.mkdir(parents=True, exist_ok=True)

    all_points: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    validations: list[dict[str, Any]] = []
    for candidate in CANDIDATES:
        candidate_points = [point_row(rows, candidate, cutoff) for cutoff in cutoffs]
        all_points.extend(candidate_points)
        values = [float(row["fairness_disparity_pp"]) for row in candidate_points if row["point_valid"] == "true"]
        accuracies = [float(row["accuracy_pp"]) for row in candidate_points]
        critical_min, group_a_n, group_b_n = critical_denominators(rows, candidate)
        bootstrap_sd, bootstrap_fraction = bootstrap_stability(
            rows,
            candidate,
            cutoffs,
            int(protocol["bootstrap_replicates"]),
            int(protocol["bootstrap_seed"]),
        )
        checks = {
            "all_points_defined": len(values) == len(cutoffs),
            "critical_denominator": critical_min >= int(protocol["minimum_critical_denominator"]),
            "fairness_range": bool(values) and max(values) - min(values) >= float(protocol["minimum_fairness_range_pp"]),
            "accuracy_range": max(accuracies) - min(accuracies) >= float(protocol["minimum_accuracy_range_pp"]),
            "bootstrap_valid_fraction": bootstrap_fraction >= float(protocol["minimum_valid_bootstrap_fraction"]),
            "bootstrap_stability": bootstrap_sd <= float(protocol["maximum_bootstrap_sd_pp"]),
        }
        failed = [name for name, passed in checks.items() if not passed]
        for check, passed in checks.items():
            validations.append(
                {
                    "candidate_id": candidate.candidate_id,
                    "check": check,
                    "passed": str(passed).lower(),
                    "observed": {
                        "all_points_defined": f"{len(values)}/{len(cutoffs)}",
                        "critical_denominator": critical_min,
                        "fairness_range": f"{(max(values) - min(values)) if values else 0:.4f} pp",
                        "accuracy_range": f"{max(accuracies) - min(accuracies):.4f} pp",
                        "bootstrap_valid_fraction": f"{bootstrap_fraction:.4f}",
                        "bootstrap_stability": f"{bootstrap_sd:.4f} pp",
                    }[check],
                    "protocol_version": protocol["protocol_version"],
                }
            )
        summaries.append(
            {
                "candidate_id": candidate.candidate_id,
                "group_key": candidate.group_key,
                "group_label": candidate.group_label,
                "group_a": candidate.group_a,
                "group_b": candidate.group_b,
                "metric": candidate.metric,
                "metric_label": METRIC_LABELS[candidate.metric],
                "group_a_n": group_a_n,
                "group_b_n": group_b_n,
                "critical_denominator_min": critical_min,
                "fairness_range_pp": round((max(values) - min(values)) if values else 0, 4),
                "accuracy_range_pp": round(max(accuracies) - min(accuracies), 4),
                "bootstrap_max_sd_pp": round(bootstrap_sd, 4),
                "bootstrap_valid_fraction": round(bootstrap_fraction, 4),
                "priority_candidate": candidate.candidate_id in protocol["priority_candidates"],
                "eligible": not failed,
                "failed_gates": ";".join(failed),
                "active_view": False,
                "selection_reason": "",
                "protocol_version": protocol["protocol_version"],
            }
        )

    active_ids = select_active(summaries, protocol)
    if len(active_ids) < int(protocol["active_view_count"]):
        raise RuntimeError(
            f"only {len(active_ids)} candidates passed the frozen protocol; "
            f"{protocol['active_view_count']} are required. Do not fabricate participant trade-off data."
        )
    for summary in summaries:
        if summary["candidate_id"] in active_ids:
            summary["active_view"] = True
            summary["selection_reason"] = (
                "eligible priority candidate"
                if summary["priority_candidate"]
                else "deterministic group-first diversity/quality fill under frozen selection rule"
            )
        elif not summary["eligible"]:
            summary["selection_reason"] = f"ineligible: {summary['failed_gates']}"
        else:
            summary["selection_reason"] = "eligible but not selected after three slots were filled"

    write_csv(args.output / "tradeoff_points.csv", all_points)
    write_csv(args.output / "candidate_summary.csv", summaries)
    write_csv(args.output / "validation_report.csv", validations)
    public_content = participant_content(active_ids, all_points, CANDIDATES)
    participant_path = args.output / "participant_tradeoff.json"
    participant_path.write_text(json.dumps(public_content, indent=2) + "\n", encoding="utf-8")
    (args.output / "codebook.md").write_text(codebook_text(), encoding="utf-8")
    (args.output / "README.md").write_text(
        "# Frozen offline run\n\n"
        f"- Protocol: `{protocol['protocol_version']}`\n"
        f"- Input rows: `{len(rows)}`\n"
        f"- Cutoffs: `{len(cutoffs)}` shared values from {cutoffs[0]:.2f} to {cutoffs[-1]:.2f}\n"
        f"- Active Views: `{', '.join(active_ids)}`\n\n"
        "Regenerate from the repository root with `python3 research/generate_tradeoffs.py`. No model is trained.\n",
        encoding="utf-8",
    )

    output_files = [
        args.output / "tradeoff_points.csv",
        args.output / "candidate_summary.csv",
        args.output / "validation_report.csv",
        participant_path,
        args.output / "codebook.md",
        args.output / "README.md",
    ]
    manifest = {
        "generated_at": protocol["frozen_at"],
        "generated_at_basis": "deterministic protocol freeze timestamp",
        "study_version": "1.2.0-study-content-frozen-2026-08-13",
        "content_version": public_content["content_version"],
        "tradeoff_dataset_version": public_content["tradeoff_dataset_version"],
        "protocol": protocol,
        "input": {
            "path": str(args.input.relative_to(ROOT)),
            "sha256": sha256(args.input),
            "records": len(rows),
            "published_role": "fixed post-training test predictions",
            "provenance_limit": "The upstream repository does not publish split-generation or OOF provenance.",
        },
        "pipeline_sha256": sha256(Path(__file__)),
        "active_view_ids": active_ids,
        "candidate_count": len(CANDIDATES),
        "classification_cutoff_participant_visible": False,
        "model_training_performed": False,
        "outputs": {path.name: sha256(path) for path in output_files},
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"active_view_ids": active_ids, "output": str(args.output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
