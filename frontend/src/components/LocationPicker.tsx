import { useEffect, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Search } from "lucide-react";
import { api } from "../api";
import { ru } from "../i18n/ru";
import type { POI, Position } from "../types";

export default function LocationPicker({
  origin,
  onPick,
}: {
  origin: Position;
  onPick: (point: Position, name?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<POI[]>([]);
  const [searched, setSearched] = useState(false);
  const [lat, setLat] = useState(String(origin.lat));
  const [lon, setLon] = useState(String(origin.lon));
  const [error, setError] = useState("");
  useEffect(() => {
    if (q.trim().length < 2) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      api<{ items: POI[] }>(`/pois?q=${encodeURIComponent(q)}&limit=5`, {
        signal: controller.signal,
      })
        .then((data) => {
          setMatches(data.items);
          setSearched(true);
          setError("");
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(ru.backendError);
        });
    }, 300);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [q]);
  function apply() {
    const position = { lat: Number(lat), lon: Number(lon) };
    if (
      !lat.trim() ||
      !lon.trim() ||
      !Number.isFinite(position.lat) ||
      !Number.isFinite(position.lon) ||
      Math.abs(position.lat) > 90 ||
      Math.abs(position.lon) > 180
    ) {
      setError(ru.invalidCoordinates);
      return;
    }
    onPick(position);
  }
  return (
    <div className="location-picker">
      <p>{ru.locationHint}</p>
      <label className="location-search">
        <Search size={16} />
        <input
          aria-label={ru.locationSearch}
          placeholder={ru.locationPlaceholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSearched(false);
            setMatches([]);
          }}
        />
      </label>
      {q.length >= 2 && matches.length > 0 && (
        <ul className="location-matches">
          {matches.map((poi) => (
            <li key={poi.id}>
              <button type="button" onClick={() => onPick(poi, poi.name)}>
                {poi.name}
                <ArrowUpRight size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.length >= 2 && searched && !matches.length && (
        <p className="muted">{ru.locationEmpty}</p>
      )}
      <details className="manual-coordinates">
        <summary>
          {ru.manualCoordinates}
          <ChevronDown size={18} aria-hidden="true" />
        </summary>
        <div className="coordinate-fields">
          <label>
            {ru.latitude}
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="-90"
              max="90"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </label>
          <label>
            {ru.longitude}
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="-180"
              max="180"
              value={lon}
              onChange={(e) => setLon(e.target.value)}
            />
          </label>
        </div>
        <button type="button" className="coordinate-apply" onClick={apply}>
          <Check size={18} aria-hidden="true" />
          {ru.apply}
        </button>
      </details>
      {error && (
        <p role="alert" className="error-copy">
          {error}
        </p>
      )}
    </div>
  );
}
