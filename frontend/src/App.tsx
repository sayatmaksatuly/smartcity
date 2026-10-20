import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  Footprints,
  Info,
  LocateFixed,
  Map,
  MapPin,
  MessageCircle,
  RefreshCw,
  Search,
  UserRound,
  Heart,
} from "lucide-react";
import { api } from "./api";
import ChatPanel from "./components/ChatPanel";
import FilterControls from "./components/FilterControls";
import LocationPicker from "./components/LocationPicker";
import Modal from "./components/Modal";
import ResultCard from "./components/ResultCard";
import RoutePanel from "./components/RoutePanel";
import { ru, routingRu } from "./i18n/ru";
import { useWalkingRoute } from "./useWalkingRoute";
import { useAccount } from "./account/AccountProvider";
import AccountDialog from "./account/AccountDialog";
import type { SavedWalk } from "./account/types";
import { useCityChat } from "./useCityChat";
import type {
  DataStatus,
  Filters,
  POI,
  Position,
  Recommendation,
  RecommendationResponse,
} from "./types";

const CityMap = lazy(() => import("./components/CityMap"));
type View = "home" | "plan" | "results" | "chat" | "map";
class MapBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="error-state" role="alert">
        {ru.mapUnavailable}
      </p>
    ) : (
      this.props.children
    );
  }
}
const EMPTY_RESULTS: Recommendation[] = [];
const INITIAL_FILTERS: Filters = {
  duration_minutes: 60,
  categories: [],
  travel_mode: "walking",
  round_trip: true,
  open_now: false,
  free_only: false,
};

export default function App() {
  const account = useAccount();
  const [origin, setOrigin] = useState<Position>({
    lat: 51.1282,
    lon: 71.4305,
  });
  const [originName, setOriginName] = useState<string>(ru.defaultStart);
  const [originConfirmed, setOriginConfirmed] = useState(false);
  const [geoAccuracy, setGeoAccuracy] = useState<number | null>(null);
  const [originIsGps, setOriginIsGps] = useState(false);
  const geoRequest = useRef(0);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const routing = useWalkingRoute(origin, originConfirmed, filters.duration_minutes);
  const [walkPlanner, setWalkPlanner] = useState(false);
  const [savedMapPlaces, setSavedMapPlaces] = useState<POI[] | null>(null);
  const [savedMapNotice, setSavedMapNotice] = useState("");
  const [startChanged, setStartChanged] = useState(false);
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [nearby, setNearby] = useState<POI[]>([]);
  const [response, setResponse] = useState<RecommendationResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState(false);
  const [geoError, setGeoError] = useState("");
  const [modal, setModal] = useState<"about" | "data" | "location" | null>(
    null,
  );
  const [view, setView] = useState<View>("home");
  const [mapVisited, setMapVisited] = useState(false);
  const mapReturn = useRef<View>("results");
  const mainRef = useRef<HTMLElement>(null);
  const navigationRevision = useRef(0);
  const pendingMapSelection = useRef<string | null>(null);
  const [dismissedOrigin, setDismissedOrigin] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  const queryRef = useRef<HTMLTextAreaElement>(null);
  const resultSource = useRef<"search" | "chat">("search");
  const chat = useCityChat({
    controller,
    filters,
    origin,
    originConfirmed,
    selected,
    onStart: () => {
      setBusy(false);
      setError("");
      // A prior standalone query must not overwrite newer conversational intent.
      setQuery("");
      resultSource.current = "chat";
    },
    onResult: (data, selectedId) => {
      routing.clear();
      setSavedMapPlaces(null);
      setStartChanged(false);
      setResponse(data);
      setStatus(data.data_status);
      setStatusError(false);
      setDismissedOrigin(false);
      setSelected((previous) =>
        data.recommendations.some((r) => r.poi.id === previous)
          ? previous
          : (selectedId ?? data.recommendations[0]?.poi.id ?? null),
      );
      if (
        pendingMapSelection.current &&
        data.recommendations.some(
          (r) => r.poi.id === pendingMapSelection.current,
        )
      ) {
        setSelected(pendingMapSelection.current);
        mapReturn.current = "chat";
        navigate("map");
      }
      pendingMapSelection.current = null;
    },
    onFilters: setFilters,
    onOrigin: (point, name) => {
      geoRequest.current += 1;
      setOrigin(point);
      setOriginConfirmed(true);
      setOriginIsGps(false);
      setGeoAccuracy(null);
      if (name) setOriginName(name);
    },
  });

  function navigate(next: View) {
    navigationRevision.current += 1;
    geoRequest.current += 1;
    setGeoBusy(false);
    if (next !== "chat") pendingMapSelection.current = null;
    if (next !== view) {
      window.history.pushState({ view: next }, "");
      setView(next);
    }
    if (next === "chat") chat.setOpen(true);
    if (next === "map") setMapVisited(true);
  }
  function openMap(id?: string) {
    setSavedMapPlaces(null);
    setSavedMapNotice("");
    routing.clear();
    setWalkPlanner(false);
    if (view !== "map") mapReturn.current = view;
    setPicking(false);
    if (id) {
      setSelected(id);
      setSelectionRevision((value) => value + 1);
    }
    navigate("map");
  }
  function startRoute(id: string) {
    chat.cancel();
    controller.current?.abort();
    controller.current = null;
    pendingMapSelection.current = null;
    setBusy(false);
    if (view !== "map") mapReturn.current = view;
    setSavedMapPlaces(null);
    setSavedMapNotice("");
    setWalkPlanner(false);
    setPicking(false);
    setSelected(id);
    routing.request([id]);
    navigate("map");
  }
  function selectOnMap(id: string) {
    setSelected(id);
    setSelectionRevision((value) => value + 1);
    if (routing.target) routing.request([id]);
  }
  function saveSelection(ids: string[]) {
    const places = savedMapPlaces ?? response?.recommendations.map((r) => r.poi) ?? [];
    const title = ids.map((id) => places.find((p) => p.id === id)?.name).filter(Boolean).join(" → ").slice(0, 100);
    void account.saveWalk({ title: title || routingRu.saveWalk, ordered_poi_ids: ids,
      user_preferences: { ...filters, round_trip: routing.target?.roundTrip ?? filters.round_trip } });
  }
  async function openSaved(ids: string[], route = false, walk?: SavedWalk) {
    chat.cancel();
    controller.current?.abort();
    controller.current = null;
    pendingMapSelection.current = null;
    setBusy(false);
    const revision = ++navigationRevision.current;
    try {
      const data = await api<{ items: POI[]; missing_ids: string[] }>("/pois/resolve", {
        method: "POST", body: JSON.stringify({ poi_ids: ids }),
      });
      if (revision !== navigationRevision.current) return;
      routing.clear();
      setSavedMapPlaces(data.items);
      setSavedMapNotice(!data.items.length ? routingRu.noSavedPlaces : data.missing_ids.length ? routingRu.missingPlaces : "");
      setSelected(data.items[0]?.id ?? null);
      setPicking(false);
      setWalkPlanner(false);
      if (walk) {
        chat.cancel();
        const preferences = walk.user_preferences;
        chat.override(preferences);
        setFilters((previous) => ({ ...previous, ...preferences }));
      }
      if (view !== "map") mapReturn.current = view;
      navigate("map");
      // A missing stop must never silently turn a saved sequence into another walk.
      if (route && data.items.length && !data.missing_ids.length)
        routing.request(data.items.map((poi) => poi.id), walk?.user_preferences.round_trip ?? false);
    } catch {
      if (revision !== navigationRevision.current) return;
      setError(ru.backendError);
      navigate("results");
    }
  }
  useEffect(() => {
    window.history.replaceState({ view: "home" }, "");
    const pop = (event: PopStateEvent) => {
      navigationRevision.current += 1;
      geoRequest.current += 1;
      setGeoBusy(false);
      pendingMapSelection.current = null;
      const next = event.state?.view;
      setView(
        ["home", "plan", "results", "chat", "map"].includes(next)
          ? next
          : "home",
      );
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);
  useEffect(() => {
    if (!mapVisited) return;
    const abort = new AbortController();
    api<{ items: POI[] }>("/pois?limit=60", { signal: abort.signal })
      .then((data) => setNearby(data.items))
      .catch(() => {});
    return () => abort.abort();
  }, [mapVisited]);

  const loadData = useCallback(async () => {
    try {
      const data = await api<DataStatus>("/data-status");
      setStatus(data);
      setStatusError(false);
    } catch {
      setStatusError(true);
    }
  }, []);
  useEffect(() => {
    void loadData();
    return () => controller.current?.abort();
  }, [loadData]);
  useEffect(() => {
    if (view !== "results") return;
    if (!response && !error) return;
    const frame = requestAnimationFrame(() => {
      resultRef.current?.scrollIntoView({
        block: "start",
        behavior: "instant",
      });
      resultRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [response, error, view]);

  function invalidate() {
    routing.clear();
    setSavedMapPlaces(null);
    setWalkPlanner(false);
    setSavedMapNotice("");
    setStartChanged(false);
    pendingMapSelection.current = null;
    chat.cancel();
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setResponse(null);
    setSelected(null);
    setError("");
  }
  function updateFilters(patch: Partial<Filters>) {
    invalidate();
    chat.override(patch);
    setFilters((previous) => ({ ...previous, ...patch }));
  }
  function pick(point: Position, name?: string, accuracy?: number) {
    geoRequest.current += 1;
    setGeoBusy(false);
    const originView = view === "map" ? mapReturn.current : view;
    const resumeChat =
      chat.needsOrigin &&
      (originView === "chat" ||
        (originView === "results" && resultSource.current === "chat"));
    const retainRoute = view === "map" && Boolean(routing.target || walkPlanner || savedMapPlaces);
    if (!retainRoute) invalidate();
    else {
      chat.cancel();
      controller.current?.abort();
      setBusy(false);
      setStartChanged(true);
    }
    chat.discardOrigin();
    setOrigin({ lat: point.lat, lon: point.lon });
    setOriginName(name || ru.manualStart);
    setOriginConfirmed(true);
    setOriginIsGps(accuracy !== undefined);
    setGeoAccuracy(accuracy ?? null);
    setPicking(false);
    setGeoError("");
    setModal(null);
    if (view === "map" && !retainRoute) navigate(mapReturn.current);
    if (resumeChat) chat.usePosition(point, name || ru.manualStart);
  }
  function locate() {
    if (geoBusy) return;
    if (!window.isSecureContext) { setGeoError(routingRu.geoSecure); return; }
    if (!navigator.geolocation) {
      setGeoError(routingRu.geoUnavailable);
      return;
    }
    setGeoBusy(true);
    setGeoError("");
    const request = ++geoRequest.current;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (request !== geoRequest.current) return;
        pick(
          { lat: position.coords.latitude, lon: position.coords.longitude },
          ru.geoStart,
          position.coords.accuracy,
        );
        setGeoBusy(false);
      },
      (failure) => {
        if (request !== geoRequest.current) return;
        setGeoError(failure.code === 1 ? routingRu.geoPermission : failure.code === 3 ? routingRu.geoTimeout : routingRu.geoUnavailable);
        setGeoBusy(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }
  async function search(
    overrides: { position?: Position; duration_minutes?: number } = {},
  ) {
    if (chat.isPending()) return;
    navigate("results");
    chat.cancel();
    if (chat.context) {
      if (overrides.duration_minutes != null)
        chat.override({ duration_minutes: overrides.duration_minutes });
      chat.search(query, overrides.position);
      return;
    }
    chat.discardOrigin();
    resultSource.current = "search";
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError("");
    routing.clear();
    setSavedMapPlaces(null);
    setDismissedOrigin(false);

    const timeout = setTimeout(() => current.abort("timeout"), 30_000);
    try {
      const data = await api<RecommendationResponse>("/recommendations", {
        method: "POST",
        body: JSON.stringify({
          position: origin,
          query,
          ...filters,
          ...overrides,
        }),
        signal: current.signal,
      });
      if (controller.current !== current) return;
      setResponse(data);
      setStartChanged(false);
      setStatus(data.data_status);
      setStatusError(false);
      setSelected(data.recommendations[0]?.poi.id ?? null);
    } catch (err) {
      if (controller.current !== current) return;
      if (current.signal.reason === "timeout") setError(ru.timeoutError);
      else if (!current.signal.aborted)
        setError(
          err instanceof TypeError
            ? ru.backendError
            : err instanceof Error
              ? err.message
              : ru.backendError,
        );
    } finally {
      clearTimeout(timeout);
      if (controller.current === current) setBusy(false);
    }
  }
  const results = response?.recommendations ?? EMPTY_RESULTS;
  const mapPlaces = savedMapPlaces ?? results.map((result) => result.poi);
  const mapResults = savedMapPlaces ? savedMapPlaces.map((poi) => ({ poi })) : results;

  const mapBackLabel =
    mapReturn.current === "chat"
      ? ru.returnChat
      : mapReturn.current === "plan"
        ? ru.returnPlan
        : mapReturn.current === "home"
          ? ru.home
          : ru.returnResults;
  const startControl = (
    <button
      className="start-value"
      aria-label={ru.changeStart}
      onClick={() => setModal("location")}
    >
      <MapPin size={19} aria-hidden="true" />
      <span>
        {ru.start}: <strong>{originName}</strong>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
  const searchForm = (
    <form
      className={`search-form ${view === "home" ? "hero-search" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void search();
      }}
    >
      <label className="field-label" htmlFor="city-query">
        {ru.queryLabel}
      </label>
      <div className="query-field">
        <textarea
          ref={queryRef}
          id="city-query"
          maxLength={600}
          rows={2}
          value={query}
          placeholder={ru.queryPlaceholder}
          onChange={(event) => {
            invalidate();
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (!busy && !chat.busy && status?.count !== 0) void search();
            }
          }}
        />
        <button
          className="primary-button search-button"
          type="submit"
          disabled={busy || chat.busy || status?.count === 0}
        >
          {busy || chat.busy ? (
            <RefreshCw size={20} className="spin" aria-hidden="true" />
          ) : (
            <Search size={20} aria-hidden="true" />
          )}
          {busy || chat.busy
            ? ru.searching
            : view === "plan"
              ? ru.planSubmit
              : ru.search}
        </button>
      </div>
    </form>
  );
  const refine = (
    <details className="refine-panel">
      <summary>
        {ru.refineConditions}
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      {chat.context && <p className="muted">{ru.chatActive}</p>}
      <FilterControls filters={filters} onChange={updateFilters} />
      {view === "results" || view === "chat" ? (
        <button
          className="primary-button"
          disabled={busy || chat.busy || status?.count === 0}
          onClick={() => void search()}
        >
          {ru.search}
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      ) : null}
    </details>
  );
  return (
    <div className={`app-shell view-${view}`}>
      <a className="skip-link" href="#main-content">
        {ru.skipToContent}
      </a>
      <header className="app-header">
        <button
          className="brand"
          onClick={() => navigate("home")}
          aria-label={`${ru.brand} — ${ru.home}`}
        >
          <svg viewBox="0 0 36 40" aria-hidden="true">
            <path d="M3 34 18 5l15 29M10 21h16M18 5v29" />
            <circle cx="18" cy="27" r="3" />
          </svg>
          <span>
            {ru.brand}
            <small>{ru.tagline}</small>
          </span>
        </button>
        <span className="header-city">
          <span className="city-dot" />
          {ru.city}
        </span>
        <button className="account-button" onClick={account.openAccount} aria-label={account.user ? routingRu.profile : routingRu.signIn}>
          <UserRound size={20} aria-hidden="true" />
          <span>{account.user ? routingRu.profile : routingRu.signIn}</span>
        </button>
        <button
          className="about-button"
          aria-label={ru.about}
          onClick={() => setModal("about")}
        >
          <Info size={20} aria-hidden="true" />
          <span>{ru.about}</span>
        </button>
      </header>
      {(account.error || account.notice) && <p className={account.error ? "account-error" : "account-notice"}
        role={account.error ? "alert" : "status"}>{account.error || account.notice}</p>}
      <main id="main-content" ref={mainRef} tabIndex={-1} className="workspace">
        <div className="page-container" hidden={view === "map"}>
          {view !== "home" && (
            <nav className="view-navigation" aria-label={ru.navigation}>
              <button className="text-button" onClick={() => navigate("home")}>
                <ArrowLeft size={18} aria-hidden="true" />
                {ru.home}
              </button>
              {view !== "chat" && (
                <button
                  className="text-button"
                  onClick={() => navigate("chat")}
                >
                  <MessageCircle size={18} aria-hidden="true" />
                  {ru.chatTitle}
                </button>
              )}
              {view === "chat" && response && (
                <button
                  className="text-button"
                  onClick={() => navigate("results")}
                >
                  {ru.chatResults}
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              )}
            </nav>
          )}
          {view === "home" && (
            <section className="home-section" aria-labelledby="home-heading">
              <div className="intro">
                <span className="eyebrow">{ru.homeEyebrow}</span>
                <h1 id="home-heading">{ru.title}</h1>
                <p>{ru.subtitle}</p>
              </div>
              {searchForm}
              <div className="search-context">
                {startControl}
                <span>{ru.conditionsSummary(filters.duration_minutes)}</span>
              </div>
              {refine}
              <nav className="journey-grid" aria-label={ru.journeysLabel}>
                <button
                  onClick={() => {
                    queryRef.current?.focus();
                    queryRef.current?.scrollIntoView({
                      block: "center",
                      behavior: "instant",
                    });
                  }}
                >
                  <Search size={24} aria-hidden="true" />
                  <span>
                    <strong>{ru.findJourney}</strong>
                    <small>{ru.findJourneyHint}</small>
                  </span>
                  <ArrowUpRight size={20} aria-hidden="true" />
                </button>
                <button onClick={() => navigate("plan")}>
                  <Footprints size={24} aria-hidden="true" />
                  <span>
                    <strong>{ru.planJourney}</strong>
                    <small>{ru.planJourneyHint}</small>
                  </span>
                  <ArrowUpRight size={20} aria-hidden="true" />
                </button>
                <button onClick={() => navigate("chat")}>
                  <MessageCircle size={24} aria-hidden="true" />
                  <span>
                    <strong>{ru.chatTitle}</strong>
                    <small>{ru.chatJourneyHint}</small>
                  </span>
                  <ArrowUpRight size={20} aria-hidden="true" />
                </button>
              </nav>
              {response && (
                <button
                  className="text-button resume-results"
                  onClick={() => navigate("results")}
                >
                  {ru.resumeResults}
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              )}
            </section>
          )}
          {view === "plan" && (
            <section className="plan-section">
              <div className="page-intro">
                <h1>{ru.planTitle}</h1>
                <p>{ru.planSubtitle}</p>
              </div>
              {startControl}
              <FilterControls filters={filters} onChange={updateFilters} />
              {searchForm}
              <p className="muted estimate-note">{ru.mapDisclaimer}</p>
            </section>
          )}
          <div hidden={view !== "chat"} className="chat-view">
            <div className="page-intro">
              <h1>{ru.chatHeading}</h1>
            </div>
            {startControl}
            <ChatPanel
              open={chat.open}
              onToggle={() => chat.setOpen(!chat.open)}
              messages={chat.messages}
              busy={chat.busy}
              error={chat.error}
              onSend={(text) => {
                pendingMapSelection.current = null;
                chat.send(text);
              }}
              onRetry={chat.retry}
              onReset={() => {
                invalidate();
                chat.reset();
                setFilters(INITIAL_FILTERS);
                setQuery("");
              }}
              onSelect={(id) => {
                if (results.some((r) => r.poi.id === id)) openMap(id);
                else {
                  const place = chat.messages
                    .flatMap((m) => m.places ?? [])
                    .find((p) => p.id === id);
                  if (place) {
                    pendingMapSelection.current = id;
                    chat.select(id, place.name);
                  }
                }
              }}
              selected={selected}
              currentPlaceIds={results.map((r) => r.poi.id)}
              contextSummary={[
                chat.context?.preferences.excluded_categories.length
                  ? `${ru.chatExcluded}: ${chat.context.preferences.excluded_categories.map((c) => ru.categories[c]).join(", ")}`
                  : "",
                chat.context?.preferences.prefer_nearby
                  ? ru.chatPreferNearby
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              suggestions={chat.suggestions}
              needsOrigin={chat.needsOrigin}
              onConfirmOrigin={chat.confirm}
              onChooseOrigin={() => setModal("location")}
              onUseCurrentOrigin={() =>
                chat.usePosition(
                  origin,
                  originConfirmed ? originName : ru.manualStart,
                )
              }
            />
            {view === "chat" && (
              <>
                {refine}
                {response && (
                  <button
                    className="secondary-button chat-results-button"
                    onClick={() => navigate("results")}
                  >
                    {ru.chatResults}
                    <ArrowRight size={18} aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </div>
          {view === "results" && (
            <>
              <div className="results-toolbar">
                {startControl}
                <button
                  className="text-button"
                  onClick={() => navigate("home")}
                >
                  {ru.editQuery}
                </button>
              </div>
              {refine}
              <section
                ref={resultRef}
                className="results-section"
                tabIndex={-1}
                aria-label={ru.resultTitle}
                aria-busy={busy || chat.busy}
              >
                {(busy || chat.busy) && (
                  <div className="loading-results" role="status">
                    <RefreshCw size={26} className="spin" aria-hidden="true" />
                    <h1>{ru.searching}</h1>
                    <button className="search-button primary-button" disabled>
                      {ru.searching}
                    </button>
                  </div>
                )}
                {error && (
                  <div className="error-state" role="alert">
                    <p>{error}</p>
                    <button
                      className="text-button"
                      onClick={() => void search()}
                    >
                      {ru.retry}
                      <RefreshCw size={18} aria-hidden="true" />
                    </button>
                  </div>
                )}
                {chat.error && (
                  <div className="error-state" role="alert">
                    <p>{chat.error}</p>
                    <button className="text-button" onClick={chat.retry}>
                      {ru.retry}
                    </button>
                  </div>
                )}
                {chat.needsOrigin && resultSource.current === "chat" && (
                  <button
                    className="secondary-button"
                    onClick={() => navigate("chat")}
                  >
                    {ru.chatOriginHeading}
                    <ArrowRight size={18} aria-hidden="true" />
                  </button>
                )}
                {resultSource.current === "chat" &&
                  !chat.busy &&
                  !chat.error &&
                  !chat.needsOrigin && (
                    <p className="chat-context">
                      {
                        chat.messages
                          .filter((message) => message.role === "assistant")
                          .at(-1)?.text
                      }
                    </p>
                  )}
                {response && status?.count !== 0 && (
                  <>
                    <div className="results-title">
                      <div>
                        <span className={`mode-label ${response.mode}`}>
                          {response.mode === "gemini"
                            ? ru.geminiMode
                            : ru.localMode}
                        </span>
                        <h1>
                          {results.length ? ru.resultTitle : ru.emptyTitle}
                        </h1>
                      </div>
                      {!!results.length && (
                        <button
                          className="secondary-button"
                          onClick={() => openMap()}
                        >
                          <Map size={19} aria-hidden="true" />
                          {ru.onMap}
                        </button>
                      )}
                    </div>
                    <p className="results-note">
                      {results.length ? ru.resultsNote : ru.emptyHelp}
                    </p>
                    {startChanged && <p className="intent-warning">{routingRu.changedStart}</p>}
                    {!!results.length && <div className="route-actions">
                      {results.length > 1 && <button className="secondary-button" onClick={() => {
                        openMap(); setWalkPlanner(true);
                      }}><Footprints size={18} aria-hidden="true" />{routingRu.buildWalk}</button>}
                      <button className="secondary-button" disabled={account.busy}
                        onClick={() => saveSelection(results.map((result) => result.poi.id))}>
                        <Heart size={18} aria-hidden="true" />{routingRu.saveSelection}
                      </button>
                    </div>}
                    <p className="applied-conditions">
                      {ru.appliedConditions}:{" "}
                      {response.applied_duration_minutes ??
                        filters.duration_minutes}{" "}
                      {ru.minute} ·{" "}
                      {response.applied_categories
                        .map((c) => ru.categories[c])
                        .join(", ") || ru.noInterests}
                    </p>
                    {!!response.origin_suggestions?.length &&
                      !dismissedOrigin && (
                        <div className="intent-confirmation">
                          <p>{ru.suggestedStart}</p>
                          {response.origin_suggestions.map((poi) => (
                            <button
                              key={poi.id}
                              className="text-button"
                              aria-label={`${ru.confirmStart}: ${poi.name}`}
                              onClick={() => {
                                pick(poi, poi.name);
                                void search({
                                  position: { lat: poi.lat, lon: poi.lon },
                                });
                              }}
                            >
                              <MapPin size={18} aria-hidden="true" />
                              {poi.name}
                              <ArrowRight size={18} aria-hidden="true" />
                            </button>
                          ))}
                          <button
                            className="text-button"
                            onClick={() => setDismissedOrigin(true)}
                          >
                            {ru.keepStart}
                          </button>
                        </div>
                      )}
                    {response.suggested_duration_minutes != null && (
                      <div className="intent-confirmation">
                        <p>
                          {ru.durationConflict(
                            response.suggested_duration_minutes,
                            response.applied_duration_minutes,
                          )}
                        </p>
                        <button
                          className="text-button"
                          onClick={() => {
                            const duration =
                              response.suggested_duration_minutes!;
                            updateFilters({ duration_minutes: duration });
                            void search({ duration_minutes: duration });
                          }}
                        >
                          {ru.confirmDuration}:{" "}
                          {response.suggested_duration_minutes} {ru.minute}
                          <ArrowRight size={18} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    {response.notices
                      .filter((notice) =>
                        /различаются|противоречит|одновременно|не подходят|не подтверждены/.test(
                          notice,
                        ),
                      )
                      .map((notice) => (
                        <p className="intent-warning" key={notice}>
                          {notice}
                        </p>
                      ))}
                    <div className="result-list">
                      {results.map((result, index) => (
                        <ResultCard
                          key={result.poi.id}
                          result={result}
                          index={index}
                          selected={selected === result.poi.id}
                          onSelect={() => openMap(result.poi.id)}
                          onRoute={() => startRoute(result.poi.id)}
                          onFavorite={() => void account.toggleFavorite(result.poi.id)}
                          favorite={account.isFavorite(result.poi.id)}
                          saving={account.busy}
                        />
                      ))}
                    </div>
                    {!results.length && (
                      <button
                        className="primary-button"
                        onClick={() => navigate("plan")}
                      >
                        {ru.emptyAction}
                        <ArrowRight size={18} aria-hidden="true" />
                      </button>
                    )}
                    <p className="estimate-note">{ru.mapDisclaimer}</p>
                    <details className="result-notices">
                      <summary>
                        {ru.resultDetails}
                        <ChevronDown size={18} aria-hidden="true" />
                      </summary>
                      <p className="results-message">{response.message}</p>
                      {response.notices.map((notice) => (
                        <p key={notice}>{notice}</p>
                      ))}
                    </details>
                  </>
                )}
                {!response &&
                  !busy &&
                  !chat.busy &&
                  !error &&
                  !chat.error &&
                  !chat.needsOrigin && (
                    <button
                      className="primary-button"
                      onClick={() => void search()}
                    >
                      {ru.search}
                      <ArrowRight size={18} aria-hidden="true" />
                    </button>
                  )}
              </section>
            </>
          )}
          {statusError && !error && (
            <div className="error-state" role="alert">
              <p>{ru.backendError}</p>
              <button className="text-button" onClick={() => void loadData()}>
                {ru.retry}
                <RefreshCw size={18} aria-hidden="true" />
              </button>
            </div>
          )}
          {status?.count === 0 && (
            <div className="no-data" role="status">
              <h2>{ru.noDataTitle}</h2>
              <p>{ru.noDataBody}</p>
              <button className="text-button" onClick={() => void loadData()}>
                {ru.refresh}
                <RefreshCw size={18} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
        {mapVisited && (
          <section
            hidden={view !== "map"}
            className="map-view"
            aria-label={ru.mapOverview}
          >
            <div className="map-toolbar">
              <button
                className="secondary-button"
                onClick={() => {
                  setPicking(false);
                  navigate(mapReturn.current);
                }}
              >
                <ArrowLeft size={18} aria-hidden="true" />
                {mapBackLabel}
              </button>
              <button
                className="text-button"
                onClick={() => setModal("location")}
              >
                <MapPin size={18} aria-hidden="true" />
                {ru.changeStart}
              </button>
              <button className="text-button" onClick={locate} disabled={geoBusy}>
                <LocateFixed size={18} aria-hidden="true" />{ru.geo}
              </button>
            </div>
            {geoError && <p className="route-error" role="alert">{geoError}</p>}
            {geoAccuracy !== null && <p className="geo-accuracy">{routingRu.accuracy(geoAccuracy)}</p>}
            {savedMapNotice && <p className="intent-warning" role="status">{savedMapNotice}</p>}
            {startChanged && <p className="intent-warning">{routingRu.changedStart}</p>}
            {view === "map" && <RoutePanel routing={routing} places={mapPlaces} confirmed={originConfirmed}
              onConfirm={() => setOriginConfirmed(true)} onChooseStart={() => setModal("location")}
              planner={walkPlanner} roundTrip={filters.round_trip} onBuild={(ids, roundTrip) => {
                setWalkPlanner(false); routing.request(ids, roundTrip); setSelected(ids.at(-1) ?? null);
              }} onSave={saveSelection} saveBusy={account.busy} />}
            {!!mapPlaces.length && <div className="route-destinations" aria-label={routingRu.routeTitle}>
              {mapPlaces.map((poi) => <button className="secondary-button" key={poi.id}
                aria-pressed={routing.target?.ids.length === 1 && routing.target.ids[0] === poi.id}
                onClick={() => { setWalkPlanner(false); setSelected(poi.id); routing.request([poi.id]); }}>
                <Footprints size={16} aria-hidden="true" />{routingRu.route}: {poi.name}
              </button>)}
            </div>}
            <div className="map-layout">
              {view === "map" && (
                <aside className="map-results" aria-label={ru.resultTitle}>
                  <h2>{ru.mapOverview}</h2>
                  <p className="muted">{ru.mapDisclaimer}</p>
                  {savedMapPlaces ? savedMapPlaces.map((poi) => <article className="saved-map-place" key={poi.id}>
                    <h3>{poi.name}</h3><p>{poi.address || ru.unavailableAddress}</p>
                    <button className="text-button" onClick={() => selectOnMap(poi.id)}>{ru.mapButton}</button>
                    <a href={poi.source_url} target="_blank" rel="noreferrer">{ru.source}</a>
                  </article>) : results.map((result, index) => (
                    <ResultCard
                      key={result.poi.id}
                      result={result}
                      index={index}
                      selected={selected === result.poi.id}
                      onSelect={() => selectOnMap(result.poi.id)}
                      onRoute={() => startRoute(result.poi.id)}
                      onFavorite={() => void account.toggleFavorite(result.poi.id)}
                      favorite={account.isFavorite(result.poi.id)} saving={account.busy}
                    />
                  ))}
                </aside>
              )}
              <MapBoundary>
                <Suspense
                  fallback={
                    <p className="map-loading" role="status">
                      {ru.mapLoading}
                    </p>
                  }
                >
                  <CityMap
                    origin={origin}
                    results={mapResults}
                    route={routing.route}
                    originIsGps={originIsGps}
                    accuracy={geoAccuracy}
                    selected={selected}
                    selectionRevision={selectionRevision}
                    onSelect={selectOnMap}
                    onPick={pick}
                    nearby={nearby}
                    picking={picking}
                    active={view === "map"}
                  />
                </Suspense>
              </MapBoundary>
            </div>
          </section>
        )}
      </main>
      <p className="sr-only" role="status">
        {response ? ru.resultsReady(results.length) : ""}
      </p>
      <footer className="app-footer" hidden={view === "map"}>
        <span>
          {ru.edition} · {ru.city}
        </span>
        <button className="text-button" onClick={() => setModal("data")}>
          {ru.data}
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>
        <span>{ru.privacyShort}</span>
      </footer>
      <AccountDialog onOpenPoi={(id) => void openSaved([id])} onRoutePoi={(id) => void openSaved([id], true)}
        onOpenWalk={(walk) => void openSaved(walk.ordered_poi_ids, true, walk)}
        currentPreferences={filters} onApplyPreferences={updateFilters}
        resolvePoiName={(id) => results.find((result) => result.poi.id === id)?.poi.name ?? nearby.find((poi) => poi.id === id)?.name} />
      {modal === "location" && (
        <Modal title={ru.locationSelection} onClose={() => { geoRequest.current += 1; setGeoBusy(false); setModal(null); }}>
          <LocationPicker origin={origin} onPick={pick} />
          <div className="location-actions">
            <button
              className="secondary-button"
              onClick={() => {
                setModal(null);
                mapReturn.current = view === "map" ? mapReturn.current : view;
                setPicking(true);
                navigate("map");
              }}
            >
              <Map size={19} aria-hidden="true" />
              {ru.chooseOnMap}
            </button>
            <button
              className="secondary-button"
              onClick={locate}
              disabled={geoBusy}
            >
              <LocateFixed size={19} aria-hidden="true" />
              {ru.geo}
            </button>
          </div>
          {geoError && (
            <p role="alert" className="inline-error">
              {geoError}
            </p>
          )}
        </Modal>
      )}
      {modal === "about" && (
        <Modal title={ru.aboutTitle} onClose={() => setModal(null)}>
          {ru.aboutParagraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            {ru.sourceCredit}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </Modal>
      )}
      {modal === "data" && (
        <Modal title={ru.dataTitle} onClose={() => setModal(null)}>
          <dl className="data-table">
            <div>
              <dt>{ru.source}</dt>
              <dd>{ru.dataSource}</dd>
            </div>
            <div>
              <dt>{ru.places}</dt>
              <dd>{status?.count ?? "—"}</dd>
            </div>
            <div>
              <dt>{ru.freshness}</dt>
              <dd>
                {status?.last_import
                  ? new Date(
                      status.last_import +
                        (status.last_import.endsWith("Z") ||
                        /[+-]\d\d:\d\d$/.test(status.last_import)
                          ? ""
                          : "Z"),
                    ).toLocaleString("ru-RU", { timeZone: "Asia/Qyzylorda" })
                  : ru.notImported}
              </dd>
            </div>
            <div>
              <dt>{ru.aiService}</dt>
              <dd>
                {status?.ai_configured ? ru.aiConfigured : ru.aiNotConfigured}
              </dd>
            </div>
          </dl>
          <p>{ru.dataNote}</p>
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            {ru.sourceCredit}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </Modal>
      )}
    </div>
  );
}
