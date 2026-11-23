import type { Aircraft } from '../models.ts';
import { MAX_AGE_MS } from '../geo.ts';
import { classify } from './classify.ts';

/**
 * Live ADS-B data from adsb.fi's open API (readsb format, no key needed).
 * The API sends no CORS headers, so browsers must reach it through a proxy:
 * Vite's dev/preview server does it for `/api/adsb` (see vite.config.js), and
 * production builds set VITE_ADSB_API to a proxy URL (see README).
 */
const BASE: string = (import.meta.env.VITE_ADSB_API as string | undefined) ?? '/api/adsb';

/** API limit is 250 nautical miles per query. */
const MAX_RADIUS_NM = 250;
/** Square cells of this size are fully covered by one 250 nm circle. */
const CELL_KM = 600;
const MAX_QUERIES = 6;

export interface Bounds { south: number; north: number; west: number; east: number }
export interface PointQuery { lat: number; lon: number; radiusNm: number }

/** Splits the visible area into at most MAX_QUERIES circles, closest to the centre first. */
export function planQueries(b: Bounds): PointQuery[] {
  const south = Math.max(b.south, -85), north = Math.min(b.north, 85);
  const west = Math.max(b.west, -180), east = Math.min(b.east, 180);
  const cellLat = CELL_KM / 111.2;
  const centre = { lat: (south + north) / 2, lon: (west + east) / 2 };
  const out: PointQuery[] = [];

  for (let lat = south + cellLat / 2; lat - cellLat / 2 < north; lat += cellLat) {
    const cellLon = cellLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
    for (let lon = west + cellLon / 2; lon - cellLon / 2 < east; lon += cellLon) {
      out.push({ lat: Math.min(lat, 85), lon: Math.min(lon, 180), radiusNm: MAX_RADIUS_NM });
    }
  }
  if (out.length === 0) out.push({ ...centre, radiusNm: MAX_RADIUS_NM });

  const dist = (q: PointQuery) => (q.lat - centre.lat) ** 2 + (q.lon - centre.lon) ** 2;
  return out.sort((a, b2) => dist(a) - dist(b2)).slice(0, MAX_QUERIES);
}

interface RawAircraft {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  category?: string;
  dbFlags?: number;
  ownOp?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  squawk?: string;
  seen_pos?: number;
}

/** All feed requests (view polling and corridor scans) share this gap: the API allows ~1 request/second. */
const REQUEST_GAP_MS = 1100;
let nextSlot = 0;

async function waitForSlot(signal: AbortSignal): Promise<void> {
  const at = Math.max(Date.now(), nextSlot);
  nextSlot = at + REQUEST_GAP_MS;
  const wait = at - Date.now();
  if (wait <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, wait);
    signal.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** `longCache`: the result may be served from a shared cache for a couple of minutes (corridor scans). */
export async function fetchPoint(q: PointQuery, signal: AbortSignal, longCache = false): Promise<Aircraft[]> {
  await waitForSlot(signal);
  const url = `${BASE}/v2/lat/${q.lat.toFixed(3)}/lon/${q.lon.toFixed(3)}/dist/${q.radiusNm}${longCache ? '?cache=long' : ''}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Feed responded ${res.status}`);
  const json = (await res.json()) as { ac?: RawAircraft[]; aircraft?: RawAircraft[] };
  const now = Date.now();
  const list = json.ac ?? json.aircraft ?? [];

  return list
    // skip ground vehicles and obstacles (emitter categories C0-C3), which are not aircraft
    .filter((r) => typeof r.lat === 'number' && typeof r.lon === 'number' && !r.category?.startsWith('C') && r.t !== 'GND' && r.t !== 'TWR')
    .map((r): Aircraft => {
      const onGround = r.alt_baro === 'ground';
      const callsign = (r.flight ?? '').trim();
      return {
        hex: r.hex,
        callsign,
        registration: r.r ?? '',
        type: r.t ?? '',
        operator: r.ownOp ?? '',
        kind: classify({ callsign, type: r.t ?? '', category: r.category ?? '', dbFlags: r.dbFlags ?? 0, operator: r.ownOp ?? '' }),
        lat: r.lat!,
        lon: r.lon!,
        altFt: typeof r.alt_baro === 'number' ? r.alt_baro : 0,
        onGround,
        gsKt: r.gs ?? 0,
        track: r.track ?? r.true_heading ?? 0,
        vRateFpm: r.baro_rate ?? 0,
        squawk: r.squawk ?? '',
        updatedAt: now - (r.seen_pos ?? 0) * 1000,
        trail: [],
      };
    });
}

const TRAIL_LENGTH = 40;

/** Latest known state of every aircraft, keyed by ICAO24 hex. */
export class AircraftStore {
  private map = new Map<string, Aircraft>();

  upsert(list: Aircraft[]) {
    for (const next of list) {
      const prev = this.map.get(next.hex);
      if (prev && prev.updatedAt >= next.updatedAt) continue; // stale duplicate from an overlapping query
      const trail = prev ? prev.trail : [];
      const last = trail[trail.length - 1];
      if (!last || last[0] !== next.lat || last[1] !== next.lon) {
        trail.push([next.lat, next.lon]);
        if (trail.length > TRAIL_LENGTH) trail.shift();
      }
      next.trail = trail;
      this.map.set(next.hex, next);
    }
  }

  prune(now = Date.now()) {
    for (const [hex, a] of this.map) if (now - a.updatedAt > MAX_AGE_MS) this.map.delete(hex);
  }

  /** Drops aircraft far outside the view (padded by half its size on each side). */
  pruneOutside(b: Bounds) {
    const padLat = (b.north - b.south) / 2, padLon = (b.east - b.west) / 2;
    for (const [hex, a] of this.map) {
      if (a.lat < b.south - padLat || a.lat > b.north + padLat || a.lon < b.west - padLon || a.lon > b.east + padLon) this.map.delete(hex);
    }
  }

  get(hex: string) { return this.map.get(hex); }
  values() { return this.map.values(); }
  get size() { return this.map.size; }
}
