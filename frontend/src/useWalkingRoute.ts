import { useEffect, useState } from "react";
import type { Position, WalkingRoute } from "./types";
import { routingRu } from "./i18n/ru";

export function useWalkingRoute(origin: Position, confirmed: boolean, duration: number) {
  const [target, setTarget] = useState<{ ids: string[]; roundTrip: boolean; revision: number } | null>(null);
  const [result, setResult] = useState<{ key: string; route: WalkingRoute | null; error: string } | null>(null);
  const key = target && confirmed
    ? JSON.stringify([origin.lat, origin.lon, duration, target]) : "";
  useEffect(() => {
    if (!key || !target) return;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort("timeout"), 25_000);
    let active = true;
    async function request() {
      try {
        const response = await fetch("/api/routes", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin, poi_ids: target!.ids, duration_minutes: duration, round_trip: target!.roundTrip }),
          signal: abort.signal,
        });
        const data = await response.json();
        if (!response.ok) {
          const code = data.detail?.code as keyof typeof routingRu.errors;
          throw new Error(routingRu.errors[code] ?? routingRu.errors.routing_unavailable);
        }
        if (active) setResult({ key, route: data as WalkingRoute, error: "" });
      } catch (error) {
        if (active) setResult({ key, route: null, error: abort.signal.reason === "timeout"
          ? routingRu.errors.routing_timeout
          : error instanceof TypeError ? routingRu.errors.routing_unavailable
          : error instanceof Error ? error.message : routingRu.errors.routing_unavailable });
      } finally { clearTimeout(timeout); }
    }
    void request();
    return () => { active = false; abort.abort(); clearTimeout(timeout); };
  }, [key, target, origin, duration]);
  return {
    target,
    route: key && result?.key === key ? result.route : null,
    error: key && result?.key === key ? result.error : "",
    busy: Boolean(key && result?.key !== key),
    request: (ids: string[], roundTrip = false) => setTarget({ ids, roundTrip, revision: Date.now() }),
    clear: () => setTarget(null),
    retry: () => setTarget((previous) => previous ? { ...previous, revision: Date.now() } : null),
  };
}
