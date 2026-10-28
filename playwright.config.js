"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:8787",
    browserName: "chromium",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node apps/api/src/server.js",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8787",
      SYSTEMFABRIC_API_TOKEN:
        "playwright-local-api-token-not-used-by-cookie-mocks",
      AI_PROVIDER: "mock",
      AI_ALLOWED_PROVIDERS: "mock",
      RATE_LIMIT_MAX_REQUESTS: "1000",
    },
  },
});
