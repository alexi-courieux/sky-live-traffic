import type { Aircraft, Airport } from '../models.ts';
import { distanceKm, greatCircle } from '../geo.ts';
import type { PointQuery } from './adsb.ts';
import { loadJson, saveJsonLater } from './persist.ts';

export interface ScanCell extends PointQuery {
  state: 'pending' | 'done' | 'failed';
}

/** Long-haul flights are looked for from this far out (closer planes are in the normal view scan). */
const START_KM = 600;
/** Only destinations at least this far away count as long-haul. */
const LONG_HAUL_KM = 1500;
const CELL_DEG = 5;
const RADIUS_NM = 250;

/**
 * Picks where to look for long-haul traffic of an airport. A plane bound for a far destination
 * follows the great circle towards it, so we trace that circle to every large airport and
 * keep the spots that many of these circles pass through (the busy corridors), busiest first.
 */
export function planCorridors(from: Airport, all: Airport[], budget = 40): PointQuery[] {
  const cells = new Map<string, { n: number; lat: number; lon: number }>();
  for (const to of all) {
    if (!to.isLarge || to.icao === from.icao) continue;
    const d = distanceKm(from.lat, from.lon, to.lat, to.lon);
    if (d < LONG_HAUL_KM) continue;
    const pts = greatCircle(from.lat, from.lon, to.lat, to.lon, Math.ceil(d / 100));
    for (const [lat, lon] of pts) {
      if (distanceKm(from.lat, from.lon, lat, lon) < START_KM) continue;
      const row = Math.floor(lat / CELL_DEG);
      const width = CELL_DEG / Math.max(Math.cos(((row + 0.5) * CELL_DEG * Math.PI) / 180), 0.25);
      const key = `${row}:${Math.floor(lon / width)}`;
      const c = cells.get(key) ?? { n: 0, lat: 0, lon: 0 };
      c.n++; c.lat += lat; c.lon += lon;
      cells.set(key, c);
    }
  }
  return [...cells.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, budget)
    .map((c) => ({ lat: c.lat / c.n, lon: c.lon / c.n, radiusNm: RADIUS_NM }));
}

/** A finished scan is reused as is for this long before the corridors are scanned again. */
const SCAN_FRESH_MS = 5 * 60_000;
/** A plane seen by a scan is dropped after this long: dead-reckoning is too far off beyond it. */
const SNAPSHOT_TTL_MS = 15 * 60_000;

const scanCache = new Map<string, { completedAt: number | null; aircraft: Map<string, Aircraft> }>();

// Scans also survive a reload (localStorage). Only airline-style planes still within their TTL are kept, and
// only the most recently scanned airports, to stay well inside the storage quota.
const STORAGE_KEY = 'skymap.scans.v1';
const STORAGE_MAX_AIRPORTS = 4;
type StoredScans = Record<string, { c: number | null; at: number; a: Omit<Aircraft, 'trail'>[] }>;
const touched = new Map<string, number>(); // icao -> last save time

for (const [icao, v] of Object.entries(loadJson<StoredScans>(STORAGE_KEY) ?? {})) {
  const aircraft = new Map<string, Aircraft>();
  for (const a of v.a) if (Date.now() - a.updatedAt < SNAPSHOT_TTL_MS) aircraft.set(a.hex, { ...a, trail: [] });
  if (aircraft.size === 0) continue;
  scanCache.set(icao, { completedAt: v.c, aircraft });
  touched.set(icao, v.at);
}


/** Planes of an earlier scan that are still usable (each expires on its own age), and whether a rescan can be skipped. */
export function cachedScan(icao: string, now = Date.now()): { aircraft: Map<string, Aircraft>; fresh: boolean } {
  const entry = scanCache.get(icao);
  const aircraft = new Map<string, Aircraft>();
  if (!entry) return { aircraft, fresh: false };
  for (const [hex, a] of entry.aircraft) if (now - a.updatedAt < SNAPSHOT_TTL_MS) aircraft.set(hex, a);
  return { aircraft, fresh: entry.completedAt !== null && now - entry.completedAt < SCAN_FRESH_MS };
}

export function saveScan(icao: string, aircraft: Map<string, Aircraft>, complete: boolean) {
  const prev = scanCache.get(icao);
  scanCache.set(icao, { aircraft: new Map(aircraft), completedAt: complete ? Date.now() : prev?.completedAt ?? null });
  touched.set(icao, Date.now());
  saveJsonLater(STORAGE_KEY, () => {
    const out: StoredScans = {};
    const recent = [...touched.entries()].sort((x, y) => y[1] - x[1]).slice(0, STORAGE_MAX_AIRPORTS);
    for (const [id, at] of recent) {
      const e = scanCache.get(id);
      if (!e) continue;
      const now = Date.now();
      out[id] = {
        c: e.completedAt, at,
        a: [...e.aircraft.values()].filter((a) => now - a.updatedAt < SNAPSHOT_TTL_MS).map(({ trail: _trail, ...rest }) => rest),
      };
    }
    return out;
  });
}
