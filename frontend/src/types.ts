export type Category =
  "park" | "culture" | "landmark" | "cafe" | "recreation" | "venue";
export type Position = { lat: number; lon: number };
export type WalkingRoute = {
  provider: "openrouteservice";
  profile: "foot-walking";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  distance_m: number;
  duration_seconds: number;
  visit_minutes: number;
  total_minutes: number;
  feasible: boolean | null;
  poi_ids: string[];
  round_trip: boolean;
  attribution: string;
};
export type POI = Position & {
  id: string;
  name: string;
  category: Category;
  description: string | null;
  opening_hours: string | null;
  address: string | null;
  website: string | null;
  source_url: string;
  imported_at: string;
};
export type DataStatus = {
  count: number;
  last_import: string | null;
  osm_base_timestamp: string | null;
  source: string;
  license: string;
  bbox: [number, number, number, number];
  ai_configured: boolean;
};
export type Recommendation = {
  poi: POI;
  explanation: string;
  activity: string;
  straight_line_m: number;
  travel_minutes_estimate: number;
  visit_minutes_estimate: number;
  total_minutes_estimate: number;
  availability: "open" | "closed" | "unknown";
  facts: string[];
  cautions: string[];
};
export type RecommendationResponse = {
  mode: "gemini" | "local";
  fallback_reason: "missing_key" | "generation_failed" | "no_candidates" | null;
  recommendations: Recommendation[];
  message: string;
  notices: string[];
  candidate_count: number;
  applied_categories: Category[];
  applied_duration_minutes: number;
  suggested_duration_minutes: number | null;
  origin_suggestions: POI[];
  data_status: DataStatus;
};
export type Filters = {
  duration_minutes: number;
  categories: Category[];
  travel_mode: "walking" | "cycling";
  round_trip: boolean;
  open_now: boolean;
  free_only: boolean;
};

export type ChatPreferences = Filters & {
  excluded_categories: Category[];
  prefer_nearby: boolean;
  walking: boolean;
  relaxing: boolean;
  sightseeing: boolean;
  outdoor: boolean;
  artwork: boolean;
};
export type ChatContext = {
  preferences: ChatPreferences;
  shown_poi_ids: string[];
  seen_poi_ids: string[];
  selected_poi_id: string | null;
  pending_origin_ids: string[];
  snapshots: { preferences: ChatPreferences; shown_poi_ids: string[] }[];
};
export type ChatAction = "message" | "confirm_origin" | "previous" | "select";
export type ChatResponse = {
  message: string;
  action:
    | "recommendations"
    | "clarify_origin"
    | "confirm_origin"
    | "unsupported"
    | "selected"
    | "previous_unavailable";
  context: ChatContext;
  recommendation_response: RecommendationResponse | null;
  origin_suggestions: POI[];
  position: Position | null;
  selected_poi_id: string | null;
};
