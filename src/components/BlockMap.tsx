"use client";

import "leaflet/dist/leaflet.css";
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { Venue } from "@/lib/types";

// The restaurant's block: every named food & drink venue OpenStreetMap knows within the radius.
// Same-cuisine venues (the direct rivals) are drawn in terracotta, the rest muted.
export default function BlockMap({
  center,
  name,
  radiusM,
  venues,
  cuisine,
}: {
  center: [number, number];
  name: string;
  radiusM: number;
  venues: Venue[];
  cuisine?: string[];
}) {
  const rival = (v: Venue) => !!cuisine?.length && v.cuisine.some((c) => cuisine.includes(c));
  const ordered = [...venues].sort((a, b) => Number(rival(a)) - Number(rival(b)));
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <MapContainer
        center={center}
        zoom={16}
        scrollWheelZoom={false}
        style={{ height: 360, width: "100%" }}
        attributionControl
        className="taste-map"
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        <Circle center={center} radius={radiusM} pathOptions={{ color: "#2f4a35", weight: 1, dashArray: "4 4", fillOpacity: 0.04 }} />
        {ordered.map((v) => {
          const r = rival(v);
          return (
            <CircleMarker
              key={v.osm_id}
              center={[v.lat, v.lon]}
              radius={r ? 6 : 4}
              pathOptions={{ color: "#fffdf8", weight: 1, fillColor: r ? "#c0532c" : "#8a8273", fillOpacity: r ? 0.95 : 0.6 }}
            >
              <Tooltip direction="top" offset={[0, -4]}>
                <span className="text-[11px]">
                  <strong>{v.name}</strong> · {v.kind}
                  {v.cuisine.length ? ` · ${v.cuisine.join(", ")}` : ""} · {v.distance_m} m
                </span>
              </Tooltip>
            </CircleMarker>
          );
        })}
        <CircleMarker center={center} radius={9} pathOptions={{ color: "#fffdf8", weight: 3, fillColor: "#2f4a35", fillOpacity: 1 }}>
          <Tooltip direction="top" offset={[0, -8]} permanent>
            <span className="text-[11px] font-semibold">{name}</span>
          </Tooltip>
        </CircleMarker>
      </MapContainer>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-card px-3 py-2 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-olive" /> You
        </span>
        {!!cuisine?.length && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-terracotta" /> Same cuisine
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-muted/60" /> Other food &amp; drink
        </span>
        <span className="ml-auto">Venues: © OpenStreetMap contributors (ODbL)</span>
      </div>
    </div>
  );
}
