import { useState } from "react";
import { Footprints, Heart, RefreshCw } from "lucide-react";
import { ru, routingRu as copy } from "../i18n/ru";
import type { POI } from "../types";
import type { useWalkingRoute } from "../useWalkingRoute";
import { formatDistance } from "./ResultCard";

export default function RoutePanel({ routing, places, confirmed, onConfirm, onChooseStart, planner, roundTrip, onBuild, onSave, saveBusy }: {
  routing: ReturnType<typeof useWalkingRoute>; places: POI[]; confirmed: boolean;
  onConfirm: () => void; onChooseStart: () => void; planner: boolean; roundTrip: boolean;
  onBuild: (ids: string[], roundTrip: boolean) => void;
  onSave: (ids: string[]) => void; saveBusy: boolean;
}) {
  const [stops, setStops] = useState<string[]>([]);
  const route = routing.route;
  const orderedStops = stops.filter((id) => places.some((place) => place.id === id));
  if (!routing.target && !planner) return null;
  return <section className="routing-panel" aria-label={copy.routeTitle}>
    {planner && <div className="route-planner">
      <h2>{copy.planner}</h2><p>{copy.plannerNote}</p>
      <div className="route-stops">{places.map((poi) => <button key={poi.id} className="secondary-button"
        aria-pressed={orderedStops.includes(poi.id)} onClick={() => setStops(orderedStops.includes(poi.id)
          ? orderedStops.filter((id) => id !== poi.id) : [...orderedStops, poi.id].slice(0, 3))}>
        {orderedStops.includes(poi.id) ? `${orderedStops.indexOf(poi.id) + 1}. ` : ""}{poi.name}
      </button>)}</div>
      <div className="route-actions"><button className="primary-button" disabled={orderedStops.length < 2}
        onClick={() => onBuild(orderedStops, roundTrip)}><Footprints size={18} aria-hidden="true" />{copy.buildSelected}</button>
        {!!orderedStops.length && <button className="text-button" onClick={() => setStops([])}>{copy.resetStops}</button>}</div>
    </div>}
    {routing.target && <>
      <h2>{routing.target.ids.length > 1 ? copy.routeTitle : places.find((p) => p.id === routing.target!.ids[0])?.name ?? copy.routeTitle}</h2>
      {routing.target.ids.length > 1 && <ol className="route-itinerary">{routing.target.ids.map((id) =>
        <li key={id}>{places.find((place) => place.id === id)?.name}</li>)}</ol>}
      {!confirmed && <div className="route-pending">
        <h3>{copy.confirmTitle}</h3><p>{copy.confirmNote}</p>
        <div className="route-actions"><button className="primary-button" onClick={onConfirm}>{copy.confirmDefault}</button>
          <button className="secondary-button" onClick={onChooseStart}>{ru.changeStart}</button></div>
      </div>}
      {routing.busy && <p role="status" className="route-pending"><RefreshCw className="spin" size={18} aria-hidden="true" />{copy.pending}</p>}
      {routing.error && <div role="alert" className="route-error"><p>{routing.error}</p>
        <button className="text-button" onClick={routing.retry}>{ru.retry}</button></div>}
      {route && <div className="route-summary" role="status">
        <strong>{copy.walking} · {formatDistance(Math.round(route.distance_m))} · ~{Math.ceil(route.duration_seconds / 60)} {ru.minute}</strong>
        {route.poi_ids.length > 1 && <><p>{copy.total(Math.ceil(route.total_minutes))}</p>
          <p className={route.feasible === false ? "route-error" : ""}>{route.feasible ? copy.fits : copy.tooLong}</p></>}
        {route.poi_ids.length === 1 && route.feasible === false && <p className="route-error">{copy.tooLong}</p>}
        <details className="route-details"><summary>{copy.routeDetails}</summary>
          <p>{copy.approximate} {route.round_trip ? copy.returnIncluded : copy.returnExcluded}.</p>
          <p>{copy.placeAccess}</p>
        </details>
        <a href="https://openrouteservice.org" target="_blank" rel="noreferrer">{copy.providerNote}</a>
        {route.poi_ids.length > 1 && route.feasible === true && <button className="secondary-button" disabled={saveBusy}
          onClick={() => onSave(route.poi_ids)}><Heart size={18} aria-hidden="true" />{copy.saveWalk}</button>}
      </div>}
    </>}
  </section>;
}
