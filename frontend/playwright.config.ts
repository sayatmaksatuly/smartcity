import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  webServer: [
    {
      command:
        '"..\\.venv\\Scripts\\python.exe" ..\\backend\\tests\\e2e_server.py',
      url: "http://127.0.0.1:8001/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --port 5174",
      url: "http://127.0.0.1:5174",
      env: {
        AITU_API_TARGET: "http://127.0.0.1:8001",
        // Deterministic UI tests must never mutate the user's Supabase project.
        VITE_SUPABASE_URL: "https://aitu-test.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_deterministic",
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:5174",
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  reporter: "list",
});
