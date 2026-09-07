import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STUDY_VERSIONS = {
  study_version: "1.2.0-study-content-frozen-2026-08-13",
  consent_version: "1.0.0",
  questionnaire_version: "raw-nasa-tlx-v1+sus-v1",
  schema_version: "1.0.0",
} as const;

export type ServerOptions = {
  databasePath?: string;
  researchExportToken?: string;
  codeVersion?: string;
  generatedContentDir?: string;
  serveWeb?: boolean;
};

export function runtimeConfig(options: ServerOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  return {
    databasePath: options.databasePath ?? process.env.DATABASE_PATH ?? resolve(sourceDirectory, "../data/study.sqlite"),
    researchExportToken: options.researchExportToken ?? process.env.RESEARCH_EXPORT_TOKEN ?? "local-research-only",
    codeVersion: options.codeVersion ?? process.env.STUDY_CODE_VERSION ?? "1.2.0",
    generatedContentDir: options.generatedContentDir,
    serveWeb: options.serveWeb ?? process.env.NODE_ENV === "production",
  };
}
