import { distanceKm, greatCircle } from '../geo.ts';
import type { Aircraft } from '../models.ts';
import { loadJson, saveJsonLater } from './persist.ts';

/**
 * Scheduled routes per callsign from adsb.lol's "standing data" (a static dataset that
 * allows cross-origin reads). It is schedule-based, so the actual flight can differ.
 */
const BASE = 'https://vrs-standing-data.adsb.lol/routes';

export interface RouteAirport {
  icao: string;
  iata: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
}

export interface Route {
  callsign: string;
  airports: RouteAirport[];
  /** Great-circle samples for each leg between consecutive airports, as [lat, lon]. */
  legs: [number, number][][];
}

/** A plane further than this from its route is assumed to be flying something else. */
export const ROUTE_MAX_OFF_KM = 250;

interface RawRoute {
  _airports?: { name: string; icao: string; iata: string; location: string; lat: number; lon: number }[];
}

/** Scheduled routes rarely change, so a found route is kept for hours; a missing one is retried sooner. */
const ROUTE_TTL_MS = 6 * 3600_000;
const MISSING_TTL_MS = 30 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

const cache = new Map<string, { p: Promise<Route | null>; expires: number }>();

// Routes survive a reload in localStorage (only the airports; the legs are rebuilt). Expired entries are kept
// for a while on purpose: they are shown at once and refreshed in the background.
const STORAGE_KEY = 'skymap.routes.v1';
const STORAGE_MAX_AGE_MS = 7 * 24 * 3600_000;
const STORAGE_MAX_ENTRIES = 2500;
type StoredRoutes = Record<string, { e: number; a: RouteAirport[] | null }>;
const stored: StoredRoutes = {};

function remember(cs: string, route: Route | null, expires: number) {
  cache.set(cs, { p: Promise.resolve(route), expires });
  stored[cs] = { e: expires, a: route ? route.airports : null };
  saveJsonLater(STORAGE_KEY, () => {
    const keep = Object.entries(stored).sort((x, y) => y[1].e - x[1].e).slice(0, STORAGE_MAX_ENTRIES);
    return Object.fromEntries(keep);
  });
}

function buildRoute(cs: string, airports: RouteAirport[]): Route {
  const legs = airports.slice(1).map((b, i) => {
    const a = airports[i];
    const n = Math.min(120, Math.max(8, Math.ceil(distanceKm(a.lat, a.lon, b.lat, b.lon) / 50)));
    return greatCircle(a.lat, a.lon, b.lat, b.lon, n);
  });
  return { callsign: cs, airports, legs };
}

for (const [cs, v] of Object.entries(loadJson<StoredRoutes>(STORAGE_KEY) ?? {})) {
  if (Date.now() - v.e > STORAGE_MAX_AGE_MS) continue;
  stored[cs] = v;
  cache.set(cs, { p: Promise.resolve(v.a && v.a.length >= 2 ? buildRoute(cs, v.a) : null), expires: v.e });
}

export function fetchRoute(callsign: string): Promise<Route | null> {
  const cs = callsign.trim().toUpperCase();
  if (cs.length < 3) return Promise.resolve(null);
  const hit = cache.get(cs);
  if (hit && hit.expires > Date.now()) return hit.p;
  if (hit) {
    // Stale-while-revalidate: answer from the old entry now, refresh it in the background.
    hit.expires = Date.now() + RETRY_AFTER_FAILURE_MS; // no duplicate refreshes meanwhile
    load(cs).then(({ route, ttl }) => {
      if (ttl > 0) remember(cs, route, Date.now() + ttl);
    });
    return hit.p;
  }
  const entry = { p: Promise.resolve<Route | null>(null), expires: Infinity }; // pending entries never expire
  entry.p = load(cs).then(({ route, ttl }) => {
    if (ttl > 0) remember(cs, route, Date.now() + ttl);
    else cache.delete(cs); // network failure: try again next time
    return route;
  });
  cache.set(cs, entry);
  return entry.p;
}

async function load(cs: string): Promise<{ route: Route | null; ttl: number }> {
  try {
    const res = await fetch(`${BASE}/${cs.slice(0, 2)}/${cs}.json`);
    if (res.status === 404) return { route: null, ttl: MISSING_TTL_MS };
    if (!res.ok) throw new Error(String(res.status));
    const raw = (await res.json()) as RawRoute;
    const airports = (raw._airports ?? []).map((a): RouteAirport => ({
      icao: a.icao, iata: a.iata, name: a.name, city: a.location, lat: a.lat, lon: a.lon,
    }));
    if (airports.length < 2) return { route: null, ttl: MISSING_TTL_MS };
    return { route: buildRoute(cs, airports), ttl: ROUTE_TTL_MS };
  } catch {
    return { route: null, ttl: 0 };
  }
}

/** A tracked aircraft whose scheduled route starts or ends at a given airport. */
export interface AirportFlight {
  hex: string;
  callsign: string;
  /** Last known state; used when the plane is not in the live store (found by a corridor scan). */
  aircraft: Aircraft;
  dir: 'dep' | 'arr';
  /** The leg touching the airport, ordered origin → destination, as [lat, lon]. */
  pts: [number, number][];
  /** The other end of the leg */
  other: RouteAirport;
}

const AIRLINE_CALLSIGN = /^[A-Z]{3}[0-9]/;
const MAX_CANDIDATES = 1500;
const CANDIDATE_RADIUS_KM = Infinity;

/**
 * Finds the tracked aircraft that are scheduled to depart from or arrive at the airport.
 * Every tracked plane is checked (nearest first, capped), since route files are fetched per callsign.
 */
export async function fetchAirportFlights(
  icao: string,
  lat: number,
  lon: number,
  aircraft: Iterable<Aircraft>,
): Promise<AirportFlight[]> {
  const candidates = [...aircraft]
    .filter((a) => AIRLINE_CALLSIGN.test(a.callsign)) // registrations and private callsigns have no scheduled route
    .map((a) => ({ a, d: distanceKm(lat, lon, a.lat, a.lon) }))
    .filter((c) => c.d <= CANDIDATE_RADIUS_KM)
    .sort((x, y) => x.d - y.d)
    .slice(0, MAX_CANDIDATES);
  const routes = await Promise.all(candidates.map((c) => fetchRoute(c.a.callsign)));
  const out: AirportFlight[] = [];
  candidates.forEach(({ a }, i) => {
    const route = routes[i];
    if (!route) return;
    const last = route.airports.length - 1;
    const loc = locateOnRoute(route, a.lat, a.lon);
    if (loc.offKm > ROUTE_MAX_OFF_KM) return;
    if (route.airports[0].icao === icao && loc.leg === 0) {
      out.push({ hex: a.hex, callsign: a.callsign, aircraft: a, dir: 'dep', pts: route.legs[0], other: route.airports[1] });
    } else if (route.airports[last].icao === icao && loc.leg === last - 1) {
      out.push({ hex: a.hex, callsign: a.callsign, aircraft: a, dir: 'arr', pts: route.legs[last - 1], other: route.airports[last - 1] });
    }
  });
  return out;
}

/** Which leg of the route the position is closest to, and how far off the route it is. */
export function locateOnRoute(route: Route, lat: number, lon: number): { leg: number; index: number; offKm: number } {
  let best = { leg: 0, index: 0, offKm: Infinity };
  route.legs.forEach((pts, leg) => {
    pts.forEach(([pLat, pLon], index) => {
      const d = distanceKm(lat, lon, pLat, pLon);
      if (d < best.offKm) best = { leg, index, offKm: d };
    });
  });
  return best;
}
