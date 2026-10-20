import { useRef, useState, type RefObject } from "react";
import { api } from "./api";
import type { ChatMessage } from "./components/ChatPanel";
import { ru } from "./i18n/ru";
import type {
  ChatAction,
  ChatContext,
  ChatResponse,
  Filters,
  POI,
  Position,
  RecommendationResponse,
} from "./types";

type Attempt = {
  text: string;
  action?: ChatAction;
  poi?: POI;
  selectId?: string;
  position?: Position;
  originName?: string;
  echo?: string;
};

export function useCityChat({
  controller,
  filters,
  origin,
  originConfirmed,
  selected,
  onStart,
  onResult,
  onFilters,
  onOrigin,
}: {
  controller: RefObject<AbortController | null>;
  filters: Filters;
  origin: Position;
  originConfirmed: boolean;
  selected: string | null;
  onStart: () => void;
  onResult: (result: RecommendationResponse, selected: string | null) => void;
  onFilters: (filters: Filters) => void;
  onOrigin: (position: Position, name?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [suggestions, setSuggestions] = useState<POI[]>([]);
  const [needsOrigin, setNeedsOrigin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const contextRef = useRef<ChatContext | null>(null);
  const overrides = useRef<Partial<Filters>>({});
  const active = useRef<AbortController | null>(null);
  const lastAttempt = useRef<Attempt | null>(null);
  const sequence = useRef(0);

  function append(message: Omit<ChatMessage, "id">) {
    const entry = { ...message, id: String(++sequence.current) };
    setMessages((previous) => [...previous, entry].slice(-8));
  }

  function cancel() {
    active.current?.abort();
    active.current = null;
    lastAttempt.current = null;
    setBusy(false);
    setError("");
  }

  function override(patch: Partial<Filters>) {
    overrides.current = { ...overrides.current, ...patch };
    if (contextRef.current) {
      const preferences = { ...contextRef.current.preferences, ...patch };
      if (patch.categories) {
        preferences.excluded_categories =
          preferences.excluded_categories.filter(
            (category) => !patch.categories!.includes(category),
          );
      }
      contextRef.current = { ...contextRef.current, preferences };
      setContext(contextRef.current);
    }
  }

  function discardOrigin() {
    // An old suggested origin must never override a later explicit UI action.
    setSuggestions([]);
    setNeedsOrigin(false);
    if (contextRef.current) {
      contextRef.current = { ...contextRef.current, pending_origin_ids: [] };
      setContext(contextRef.current);
    }
  }

  async function run(attempt: Attempt, retry = false) {
    if (
      active.current ||
      (!attempt.text.trim() && !attempt.action) ||
      attempt.text.length > 600
    )
      return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    active.current = current;
    lastAttempt.current = attempt;
    setBusy(true);
    setError("");
    setOpen(true);
    onStart();
    if (!retry) append({ role: "user", text: attempt.echo ?? attempt.text });
    const timeout = setTimeout(() => current.abort("timeout"), 30_000);
    try {
      const data = await api<ChatResponse>("/chat", {
        method: "POST",
        signal: current.signal,
        body: JSON.stringify({
          message: attempt.text,
          action: attempt.action ?? "message",
          position: attempt.position ?? (originConfirmed ? origin : null),
          context: contextRef.current,
          overrides: contextRef.current
            ? overrides.current
            : { ...filters, ...overrides.current },
          selected_poi_id: attempt.selectId ?? selected,
          confirm_origin_id: attempt.poi?.id ?? null,
        }),
      });
      // Checking identity as well as abort makes late replies harmless even if
      // the transport cannot cancel an already completed server generation.
      if (active.current !== current || controller.current !== current) return;
      if (current.signal.aborted) {
        if (current.signal.reason === "timeout") setError(ru.timeoutError);
        return;
      }
      contextRef.current = data.context;
      setContext(data.context);
      overrides.current = {};
      const p = data.context.preferences;
      onFilters({
        duration_minutes: p.duration_minutes,
        categories: p.categories,
        travel_mode: p.travel_mode,
        round_trip: p.round_trip,
        free_only: p.free_only,
        open_now: p.open_now,
      });
      if (
        data.position &&
        (attempt.position || (attempt.poi && data.action === "recommendations"))
      ) {
        onOrigin(data.position, attempt.poi?.name ?? attempt.originName);
      }
      setSuggestions(data.origin_suggestions);
      setNeedsOrigin(
        data.action === "clarify_origin" || data.action === "confirm_origin",
      );
      if (data.recommendation_response) {
        onResult(data.recommendation_response, data.selected_poi_id);
      }
      append({
        role: "assistant",
        text: data.message,
        mode: data.recommendation_response?.mode ?? "local",
        places: data.recommendation_response?.recommendations.map((r) => ({
          id: r.poi.id,
          name: r.poi.name,
        })),
      });
      lastAttempt.current = null;
    } catch {
      if (active.current !== current || controller.current !== current) return;
      if (current.signal.reason === "timeout") setError(ru.timeoutError);
      else if (!current.signal.aborted) setError(ru.chatNetworkError);
    } finally {
      clearTimeout(timeout);
      if (active.current === current && controller.current === current) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function reset() {
    cancel();
    contextRef.current = null;
    overrides.current = {};
    setContext(null);
    setMessages([]);
    setSuggestions([]);
    setNeedsOrigin(false);
  }

  return {
    open,
    setOpen,
    messages,
    context,
    busy,
    error,
    suggestions,
    needsOrigin,
    cancel,
    override,
    reset,
    discardOrigin,
    send: (text: string) => void run({ text }),
    isPending: () => active.current !== null,
    search: (text: string, position?: Position) =>
      void run({ text: text.trim() || ru.chatShowOptions, position }),
    retry: () => {
      if (lastAttempt.current) void run(lastAttempt.current, true);
    },
    confirm: (poi: POI) =>
      void run({
        text: "",
        action: "confirm_origin",
        poi,
        echo: ru.chatConfirmOrigin(poi.name),
      }),
    usePosition: (position: Position, originName?: string) =>
      void run({
        text: ru.chatShowOptions,
        position,
        originName,
        echo: ru.chatCurrentOrigin,
      }),
    select: (id: string, name: string) =>
      void run({
        text: "",
        action: "select",
        selectId: id,
        echo: ru.chatSelectPlace(name),
      }),
  };
}
