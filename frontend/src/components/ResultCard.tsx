import { Clock3, ExternalLink, MapPin, Footprints, Heart } from "lucide-react";
import { ru, routingRu } from "../i18n/ru";
import type { Recommendation } from "../types";

export function formatDistance(m: number) {
  return m < 1000 ? `${m} м` : `${(m / 1000).toFixed(1).replace(".", ",")} км`;
}

export default function ResultCard({
  result,
  index,
  selected,
  onSelect,
  onRoute,
  onFavorite,
  favorite = false,
  saving = false,
}: {
  result: Recommendation;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onRoute?: () => void;
  onFavorite?: () => void;
  favorite?: boolean;
  saving?: boolean;
}) {
  return (
    <article
      id={`result-${result.poi.id}`}
      className={`result-card ${selected ? "selected" : ""}`}
      data-testid="result-card"
    >
      <div className="result-heading">
        <span className="result-number">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span>
          <span className="category-label">
            {ru.categories[result.poi.category]}
          </span>
          <h3>{result.poi.name}</h3>
        </span>
      </div>
      <div className="result-content">
        <div className="result-meta">
          <span>
            <MapPin size={13} />
            {formatDistance(result.straight_line_m)} {ru.distance}
          </span>
          <span>
            <Clock3 size={16} aria-hidden="true" />~
            {result.total_minutes_estimate} {ru.minute} · {ru.estimated}
          </span>
        </div>
        <p>{result.explanation}</p>
        <p className="result-address">
          {result.poi.address || ru.unavailableAddress}
        </p>
        <div className="result-bottom">
          <span className={`availability ${result.availability}`}>
            <i />
            {result.availability === "open"
              ? ru.open
              : result.availability === "closed"
                ? ru.closed
                : ru.unknown}
          </span>
          <button
            className="secondary-button"
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={`${ru.onMap}: ${result.poi.name}`}
          >
            <MapPin size={18} aria-hidden="true" />
            {ru.mapButton}
          </button>
        </div>
        <div className="result-actions">
          {onRoute && <button className="primary-button" onClick={onRoute} aria-label={`${routingRu.route}: ${result.poi.name}`}>
            <Footprints size={18} aria-hidden="true" />{routingRu.route}
          </button>}
          {onFavorite && <button className="secondary-button" onClick={onFavorite} disabled={saving}
            aria-pressed={favorite} aria-label={`${favorite ? routingRu.unfavorite : routingRu.favorite}: ${result.poi.name}`}>
            <Heart size={18} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
            {favorite ? routingRu.unfavorite : routingRu.favorite}
          </button>}
        </div>
        <details>
          <summary>{ru.details}</summary>
          <div className="poi-details">
            <p>{result.activity}</p>
            <p>
              {ru.total}: ~{result.total_minutes_estimate} {ru.minute} (
              {ru.estimated}). ~{result.travel_minutes_estimate} {ru.minute}{" "}
              {ru.travel}.
            </p>
            {result.poi.address && <p>{result.poi.address}</p>}
            <p>
              {result.poi.opening_hours
                ? `${ru.hours}: ${result.poi.opening_hours}`
                : ru.unknownHours}
            </p>
            {result.facts.map((fact) => (
              <p key={fact}>{fact}</p>
            ))}
            {result.cautions.map((caution) => (
              <p key={caution} className="muted">
                {caution}
              </p>
            ))}
            <a href={result.poi.source_url} target="_blank" rel="noreferrer">
              {ru.source} <ExternalLink size={12} />
            </a>
            <span className="source-date">
              {ru.freshness}:{" "}
              {new Date(result.poi.imported_at).toLocaleDateString("ru-RU")}
            </span>
          </div>
        </details>
      </div>
    </article>
  );
}
