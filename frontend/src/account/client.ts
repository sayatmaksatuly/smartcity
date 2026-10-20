import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

function validPublicConfiguration(): boolean {
  if (!url || !key || key.startsWith("sb_secret_")) return false;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname)
      )
    )
      return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return false;
    if (key.startsWith("sb_publishable_")) return true;
    // Legacy anon JWTs are public; a service_role JWT must never initialize a browser client.
    const payload = JSON.parse(
      atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return payload.role === "anon";
  } catch {
    return false;
  }
}

export const supabase = validPublicConfiguration()
  ? createClient(url!, key!, {
      db: { timeout: 12_000, retry: false },
      global: {
        fetch: async (input, init) => {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 12_000);
          const originalSignal = init?.signal;
          try {
            return await fetch(input, {
              ...init,
              signal: originalSignal
                ? AbortSignal.any([originalSignal, controller.signal])
                : controller.signal,
            });
          } finally {
            window.clearTimeout(timeout);
          }
        },
      },
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export function authRedirect(mode: "confirm" | "recovery"): string {
  const destination = new URL(window.location.pathname, window.location.origin);
  destination.searchParams.set("auth", mode);
  return destination.href;
}
