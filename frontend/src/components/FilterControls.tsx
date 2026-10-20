import {
  Bike,
  Check,
  ChevronDown,
  Coffee,
  Compass,
  Footprints,
  Landmark,
  MapPin,
  SlidersHorizontal,
  Trees,
} from "lucide-react";
import { ru } from "../i18n/ru";
import type { Category, Filters } from "../types";

const icons = {
  park: Trees,
  culture: Landmark,
  cafe: Coffee,
  landmark: Compass,
  recreation: Bike,
  venue: MapPin,
};

export default function FilterControls({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const active = [
    !filters.round_trip,
    filters.free_only,
    filters.open_now,
    filters.travel_mode === "cycling",
  ].filter(Boolean).length;
  return (
    <div className="filter-controls">
      <fieldset>
        <legend>{ru.duration}</legend>
        <div className="duration-options">
          {[...new Set([30, 60, 120, 180, filters.duration_minutes])]
            .sort((a, b) => a - b)
            .map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filters.duration_minutes === value}
                onClick={() => onChange({ duration_minutes: value })}
              >
                {ru.durationOption(value)}
              </button>
            ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{ru.interests}</legend>
        <div className="category-options">
          <button
            type="button"
            aria-pressed={!filters.categories.length}
            onClick={() => onChange({ categories: [] })}
          >
            {!filters.categories.length && (
              <Check size={18} aria-hidden="true" />
            )}
            {ru.all}
          </button>
          {(Object.keys(icons) as Category[]).map((category) => {
            const Icon = icons[category];
            const selected = filters.categories.includes(category);
            return (
              <button
                key={category}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  onChange({
                    categories: selected
                      ? filters.categories.filter((c) => c !== category)
                      : [...filters.categories, category],
                  })
                }
              >
                <Icon size={18} aria-hidden="true" />
                {ru.categories[category]}
              </button>
            );
          })}
        </div>
      </fieldset>
      <details className="advanced-filters">
        <summary>
          <SlidersHorizontal size={18} aria-hidden="true" />
          {ru.moreFilters}
          {active > 0 && <span className="filter-count">{active}</span>}
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="advanced-body">
          <div className="travel-options">
            {(["walking", "cycling"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={filters.travel_mode === mode}
                onClick={() => onChange({ travel_mode: mode })}
              >
                {mode === "walking" ? (
                  <Footprints size={18} aria-hidden="true" />
                ) : (
                  <Bike size={18} aria-hidden="true" />
                )}
                {ru[mode]}
              </button>
            ))}
          </div>
          {(["round_trip", "free_only", "open_now"] as const).map(
            (key, index) => (
              <label className="check-field" key={key}>
                <input
                  type="checkbox"
                  checked={filters[key]}
                  onChange={(e) => onChange({ [key]: e.target.checked })}
                />
                {[ru.roundTrip, ru.freeOnly, ru.openNow][index]}
              </label>
            ),
          )}
        </div>
      </details>
    </div>
  );
}
