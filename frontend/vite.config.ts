import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  const publicNames = new Set(["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_TILE_URL", "VITE_TILE_ATTRIBUTION"]);
  for (const [name, value] of Object.entries(environment)) {
    let privileged = value.startsWith("sb_secret_");
    if (value.split(".").length === 3) {
      try { privileged ||= JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()).role === "service_role"; }
      catch { /* Non-JWT public configuration. Never print its value. */ }
    }
    if (privileged || (!publicNames.has(name) && /KEY|TOKEN|SECRET|PASSWORD/i.test(name)))
      throw new Error("Private credentials are forbidden in frontend environment. Keep them on the backend.");
  }
  return {
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.AITU_API_TARGET || "http://127.0.0.1:8000" },
  },
  };
});
