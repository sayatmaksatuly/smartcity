import type { Filters } from "../types";

export type WalkPreferences = Partial<Filters>;
export type SaveWalkInput = {
  title: string;
  ordered_poi_ids: string[];
  user_preferences: WalkPreferences;
};
export type SavedWalk = SaveWalkInput & {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
};
export type AccountMode = "signin" | "signup" | "recover" | "reset" | "profile";

// Persist only intentional preferences: never chat text, coordinates or route geometry.
export function safePreferences(value: WalkPreferences): WalkPreferences {
  const result: WalkPreferences = {};
  if (
    Number.isInteger(value.duration_minutes) &&
    value.duration_minutes! >= 15 &&
    value.duration_minutes! <= 240
  )
    result.duration_minutes = value.duration_minutes;
  if (Array.isArray(value.categories))
    result.categories = value.categories.filter((entry) =>
      ["park", "culture", "landmark", "cafe", "recreation", "venue"].includes(
        entry,
      ),
    );
  if (value.travel_mode === "walking" || value.travel_mode === "cycling")
    result.travel_mode = value.travel_mode;
  for (const key of ["round_trip", "open_now", "free_only"] as const)
    if (typeof value[key] === "boolean") result[key] = value[key];
  return result;
}

export const isPoiId = (id: string) =>
  id.length <= 40 && /^(node|way|relation)\/[1-9][0-9]*$/.test(id);
