# Offline validation output codebook

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
