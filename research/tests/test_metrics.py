import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("generate_tradeoffs", ROOT / "research" / "generate_tradeoffs.py")
pipeline = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = pipeline
SPEC.loader.exec_module(pipeline)


class MetricDefinitionTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {"sample_id": 1, "y_true": 1, "y_score": 0.9, "g": "A"},
            {"sample_id": 2, "y_true": 0, "y_score": 0.8, "g": "A"},
            {"sample_id": 3, "y_true": 1, "y_score": 0.7, "g": "B"},
            {"sample_id": 4, "y_true": 0, "y_score": 0.1, "g": "B"},
        ]

    def candidate(self, metric):
        return pipeline.Candidate("T01", "g", "Group", "A", "B", metric)

    def test_demographic_parity_is_absolute_selection_rate_gap(self):
        candidate = self.candidate("demographic_parity")
        stats = pipeline.group_stats(self.rows, candidate, 0.5)
        self.assertAlmostEqual(pipeline.disparity(candidate.metric, stats, "A", "B"), 50.0)

    def test_equal_opportunity_is_absolute_tpr_gap(self):
        candidate = self.candidate("equal_opportunity")
        stats = pipeline.group_stats(self.rows, candidate, 0.8)
        self.assertAlmostEqual(pipeline.disparity(candidate.metric, stats, "A", "B"), 100.0)

    def test_equalized_odds_is_maximum_tpr_or_fpr_gap(self):
        candidate = self.candidate("equalized_odds")
        stats = pipeline.group_stats(self.rows, candidate, 0.8)
        self.assertAlmostEqual(pipeline.disparity(candidate.metric, stats, "A", "B"), 100.0)

    def test_accuracy_uses_good_credit_as_positive(self):
        self.assertAlmostEqual(pipeline.accuracy(self.rows, 0.5), 75.0)

    def test_undefined_denominator_is_not_fabricated(self):
        rows = [row for row in self.rows if not (row["g"] == "B" and row["y_true"] == 0)]
        candidate = self.candidate("equalized_odds")
        stats = pipeline.group_stats(rows, candidate, 0.5)
        self.assertIsNone(pipeline.disparity(candidate.metric, stats, "A", "B"))


class ReproducibilityTests(unittest.TestCase):
    def test_frozen_input_generates_three_non_cutoff_public_views(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            result = pipeline.main(["--output", str(output)])
            self.assertEqual(result, 0)
            content = json.loads((output / "participant_tradeoff.json").read_text())
            self.assertEqual(len(content["active_views"]), 3)
            self.assertFalse(content["classification_cutoff_exposed"])
            for view in content["active_views"]:
                self.assertNotIn("classification_cutoff", view)
                for point in view["points"]:
                    self.assertNotIn("classification_cutoff", point)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertFalse(manifest["model_training_performed"])
            self.assertEqual(manifest["candidate_count"], 9)

    def test_two_runs_are_byte_reproducible(self):
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first, second = Path(first_dir), Path(second_dir)
            pipeline.main(["--output", str(first)])
            pipeline.main(["--output", str(second)])
            expected = {"tradeoff_points.csv", "candidate_summary.csv", "validation_report.csv", "participant_tradeoff.json", "codebook.md", "README.md", "manifest.json"}
            self.assertEqual({path.name for path in first.iterdir()}, expected)
            for name in expected:
                self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)


if __name__ == "__main__":
    unittest.main()
