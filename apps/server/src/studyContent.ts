import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TradeoffPoint = {
  model_config_id: string;
  accuracy_pp: number;
  fairness_disparity_pp: number;
};

export type ActiveView = {
  view_id: string;
  title: string;
  group_key: string;
  group_label: string;
  group_a: string;
  group_b: string;
  metric: string;
  metric_label: string;
  description: string;
  points: TradeoffPoint[];
};

export type StudyContent = {
  content_version: string;
  tradeoff_dataset_version: string;
  units: string;
  positive_outcome: string;
  utility: string;
  classification_cutoff_exposed: false;
  active_views: ActiveView[];
};

function defaultGeneratedDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../research/generated");
}

export function loadStudyContent(generatedDir?: string): StudyContent {
  const directory = generatedDir ?? defaultGeneratedDir();
  const content = JSON.parse(readFileSync(resolve(directory, "participant_tradeoff.json"), "utf8")) as StudyContent;
  if (content.classification_cutoff_exposed !== false || content.active_views.length !== 3) {
    throw new Error("Participant study content is not a valid three-view frozen pack");
  }
  const serialized = JSON.stringify(content.active_views);
  if (/classification_cutoff/i.test(serialized)) {
    throw new Error("Participant study content leaks a model classification cutoff");
  }
  return content;
}

export function loadResearchManifest(generatedDir?: string) {
  return JSON.parse(readFileSync(resolve(generatedDir ?? defaultGeneratedDir(), "manifest.json"), "utf8")) as Record<string, unknown>;
}

export function loadOfflineCodebook(generatedDir?: string) {
  return readFileSync(resolve(generatedDir ?? defaultGeneratedDir(), "codebook.md"), "utf8");
}
