import { useEffect, useRef, useState } from "react";
import {
  CircleMarker,
  Circle,
  MapContainer,
  Marker,
  Popup,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
  ZoomControl,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ArrowUpRight, Crosshair, MapPin, Navigation } from "lucide-react";
import type { POI, Position, WalkingRoute } from "../types";
import { ru, routingRu } from "../i18n/ru";

type MapPlace = { poi: POI };

// A custom tile source is opt-in and must ship its required attribution.
const customTiles = import.meta.env.VITE_TILE_URL && import.meta.env.VITE_TILE_ATTRIBUTION;
const tileUrl = customTiles ? import.meta.env.VITE_TILE_URL : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · ODbL';
// Attribution accepts HTML in Leaflet: custom provider text is escaped before insertion.
const providerAttribution = String(import.meta.env.VITE_TILE_ATTRIBUTION || "").replace(/[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

const originIcon = L.divIcon({
  className: "origin-marker",
  html: "<span></span>",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});
const numberIcon = (number: number, selected: boolean, offset = 0) =>
  L.divIcon({
    className: `result-marker ${selected ? "is-selected" : ""}`,
    html: `${offset ? `<svg class="marker-leader" width="38" height="44"><line x1="19" y1="42" x2="${19 - offset}" y2="42" /></svg>` : ""}<span><b>${number}</b></span>`,
    iconSize: [38, 44],
    iconAnchor: [19 - offset, 42],
  });

function ResultMarkers({
  results,
  selected,
  onSelect,
}: {
  results: MapPlace[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const points = results.map((r) => map.project([r.poi.lat, r.poi.lon], zoom));
  const groups: number[][] = [];
  points.forEach((point, index) => {
    const near = groups.filter((group) =>
      group.some((i) => point.distanceTo(points[i]) < 55),
    );
    if (!near.length) groups.push([index]);
    else {
      near[0].push(index, ...near.slice(1).flat());
      near.slice(1).forEach((group) => groups.splice(groups.indexOf(group), 1));
    }
  });
  return results.map((r, index) => {
    const group = groups.find((g) => g.includes(index))!;
    const ordered = [...group].sort(
      (a, b) => points[a].x - points[b].x || a - b,
    );
    const offset = (ordered.indexOf(index) - (group.length - 1) / 2) * 60;
    return (
      <Marker
        key={r.poi.id}
        position={[r.poi.lat, r.poi.lon]}
        icon={numberIcon(index + 1, r.poi.id === selected, offset)}
        title={`${index + 1}. ${r.poi.name}`}
        zIndexOffset={r.poi.id === selected ? 1000 : 500}
        eventHandlers={{ click: () => onSelect(r.poi.id) }}
      >
        <Tooltip direction="top" offset={[0, -35]}>
          {r.poi.name}
        </Tooltip>
      </Marker>
    );
  });
}

function MapBehavior({
  origin,
  results,
  selected,
  onPick,
  fit,
  selectionRevision,
  picking,
  active,
  route,
}: {
  origin: Position;
  results: MapPlace[];
  selected: string | null;
  onPick: (position: Position) => void;
  fit: number;
  selectionRevision: number;
  picking: boolean;
  active: boolean;
  route: WalkingRoute | null;
}) {
  const map = useMap();
  const previous = useRef("");
  const selectionResults = useRef("");
  const previousSelection = useRef("");
  useMapEvents({
    click(event) {
      if (picking) onPick({ lat: event.latlng.lat, lon: event.latlng.lng });
    },
  });
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (map.getContainer().clientWidth) map.invalidateSize({ pan: false });
    });
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  useEffect(() => {
    if (!active || route) return;
    map.invalidateSize({ pan: false });
    const signature = `${origin.lat}:${origin.lon}:${results.map((r) => r.poi.id).join(",")}:${fit}`;
    if (signature !== previous.current) {
      previous.current = signature;
      const points: L.LatLngTuple[] = [
        [origin.lat, origin.lon],
        ...results.map((r) => [r.poi.lat, r.poi.lon] as L.LatLngTuple),
      ];
      if (points.length > 1)
        map.fitBounds(points, {
          padding: [65, 95],
          maxZoom: 15,
          animate: false,
        });
      else map.setView(points[0], 14, { animate: false });
    }
  }, [map, origin, results, fit, active, route]);
  useEffect(() => {
    if (!active || !route) return;
    map.invalidateSize({ pan: false });
    const size = map.getSize();
    map.fitBounds(route.geometry.coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngTuple), {
      paddingTopLeft: [Math.min(45, size.x / 6), Math.min(95, size.y / 3)],
      paddingBottomRight: [Math.min(45, size.x / 6), Math.min(45, size.y / 6)],
      maxZoom: 17, animate: false,
    });
  }, [map, route, active, fit]);
  useEffect(() => {
    if (!active || route) return;
    const signature = results.map((r) => r.poi.id).join(",");
    const selectionKey = `${selected}:${selectionRevision}`;
    if (selectionResults.current !== signature) {
      selectionResults.current = signature;
      previousSelection.current = selectionKey;
      return;
    }
    if (previousSelection.current === selectionKey) return;
    previousSelection.current = selectionKey;
    const result = results.find((r) => r.poi.id === selected);
    if (result)
      map.setView(
        [result.poi.lat, result.poi.lon],
        Math.max(map.getZoom(), 15),
        { animate: false },
      );
  }, [map, selected, results, selectionRevision, active, route]);
  return null;
}

export default function CityMap({
  origin,
  results,
  selected,
  onSelect,
  onPick,
  nearby,
  picking,
  selectionRevision = 0,
  active: isVisible = true,
  route = null,
  originIsGps = false,
  accuracy = null,
}: {
  origin: Position;
  results: MapPlace[];
  selected: string | null;
  onSelect: (id: string) => void;
  onPick: (position: Position) => void;
  nearby: POI[];
  picking: boolean;
  selectionRevision?: number;
  active?: boolean;
  route?: WalkingRoute | null;
  originIsGps?: boolean;
  accuracy?: number | null;
}) {
  const [fit, setFit] = useState(0);
  const [tileError, setTileError] = useState(false);
  const [tileVersion, setTileVersion] = useState(0);
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const online = () => {
      setOffline(false);
      setTileError(false);
      setTileVersion((v) => v + 1);
    };
    const offline = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  const active = results.find((r) => r.poi.id === selected);
  return (
    <section
      className={`map-panel ${picking ? "is-picking" : ""}`}
      aria-label={ru.mapLabel}
    >
      <MapContainer
        center={[origin.lat, origin.lon]}
        zoom={14}
        zoomControl={false}
        className="city-map"
        minZoom={3}
        maxZoom={19}
      >
        <TileLayer
          key={tileVersion}
          url={tileUrl}
          attribution={customTiles ? `${osmAttribution} · ${providerAttribution}` : osmAttribution}
          eventHandlers={{
            tileerror: () => setTileError(true),
          }}
        />
        <ZoomControl position="topright" />
        <MapBehavior
          origin={origin}
          results={results}
          selected={selected}
          onPick={onPick}
          fit={fit}
          selectionRevision={selectionRevision}
          picking={picking}
          active={isVisible}
          route={route}
        />
        {route && <>
          <Polyline positions={route.geometry.coordinates.map(([lon, lat]) => [lat, lon])}
            pathOptions={{ color: "#193521", weight: 9, opacity: 0.95, lineCap: "round" }} interactive={false} />
          <Polyline positions={route.geometry.coordinates.map(([lon, lat]) => [lat, lon])}
            pathOptions={{ color: "#B9F23D", weight: 5, opacity: 1, lineCap: "round", className: "walking-route" }} interactive={false} />
        </>}
        {originIsGps && accuracy !== null && accuracy > 0 && <Circle center={[origin.lat, origin.lon]} radius={accuracy}
          pathOptions={{ color: "#193521", fillColor: "#B9F23D", fillOpacity: 0.12, weight: 1 }} interactive={false} />}
        <Marker
          position={[origin.lat, origin.lon]}
          icon={originIcon}
          title={originIsGps ? routingRu.youAreHere : ru.origin}
        >
          <Tooltip direction="top" offset={[0, -10]}>
            {originIsGps ? routingRu.youAreHere : ru.origin}
          </Tooltip>
        </Marker>
        {!results.length &&
          nearby.map((poi) => (
            <CircleMarker
              key={poi.id}
              center={[poi.lat, poi.lon]}
              radius={5}
              pathOptions={{
                color: "#315c4c",
                fillColor: "#f6f4ee",
                fillOpacity: 1,
                weight: 2,
              }}
            >
              <Tooltip>{poi.name}</Tooltip>
              <Popup>
                <strong>{poi.name}</strong>
                <br />
                <button className="popup-button" onClick={() => onPick(poi)}>
                  {ru.setOrigin} <ArrowUpRight size={14} />
                </button>
              </Popup>
            </CircleMarker>
          ))}
        <ResultMarkers
          results={results}
          selected={selected}
          onSelect={onSelect}
        />
      </MapContainer>
      <div className="map-city">
        <span className="city-dot" />
        <div>
          <strong>{ru.city}</strong>
          <span>{ru.country}</span>
        </div>
      </div>
      <button
        className="map-fit icon-button"
        onClick={() => setFit((v) => v + 1)}
        aria-label={ru.fitMap}
        title={ru.fitMap}
      >
        <Crosshair size={20} />
      </button>
      <div className={`map-instruction ${picking ? "picking" : ""}`}>
        <MapPin size={15} />
        {picking ? ru.pickMap : ru.mapHint}
      </div>
      {(tileError || offline) && (
        <div className="tile-error" role="status">
          <p>{offline ? ru.offline : ru.tilesError}</p>
          {!offline && (
            <button
              className="text-button"
              onClick={() => {
                setTileError(false);
                setTileVersion((v) => v + 1);
              }}
            >
              {ru.retryMap}
            </button>
          )}
        </div>
      )}
      {!route && <div className="map-caption" aria-live="polite">
        <div className="map-caption-icon">
          <Navigation size={24} strokeWidth={1.3} />
        </div>
        <div>
          {active ? (
            <>
              <span className="eyebrow">{ru.selectedLabel}</span>
              <h3>{active.poi.name}</h3>
              <p>
                {active.poi.address ||
                  `${active.poi.lat.toFixed(5)}, ${active.poi.lon.toFixed(5)}`}
              </p>
            </>
          ) : (
            <>
              <h3>{ru.mapNoteTitle}</h3>
              <p>{ru.mapNote}</p>
            </>
          )}
        </div>
        <span className="caption-index">
          {active ? String(results.indexOf(active) + 1).padStart(2, "0") : "А"}
        </span>
      </div>}
    </section>
  );
}
