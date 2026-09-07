import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL as "chrome" | undefined,
  },
  webServer: {
    command: "env NODE_ENV=production PORT=4174 DATABASE_PATH=apps/server/data/e2e.sqlite RESEARCH_EXPORT_TOKEN=e2e npm run start",
    url: "http://127.0.0.1:4174/api/health",
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
