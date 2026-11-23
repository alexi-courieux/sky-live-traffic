import type { Aircraft } from './models.ts';

const EARTH_RADIUS_KM = 6371;
const KT_TO_KMH = 1.852;
const rad = (deg: number) => (deg * Math.PI) / 180;

export const ktToKmh = (kt: number) => kt * KT_TO_KMH;
export const ftToM = (ft: number) => ft * 0.3048;

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Aircraft older than this are dropped from the map (ms). */
export const MAX_AGE_MS = 60_000;
/** We never extrapolate further than this beyond the last report (ms). */
const MAX_EXTRAPOLATION_MS = 30_000;

/** Dead-reckons the aircraft position between two feed updates. */
export function extrapolate(a: Aircraft, now: number, maxMs = MAX_EXTRAPOLATION_MS): { lat: number; lon: number } {
  if (a.onGround || a.gsKt < 5) return { lat: a.lat, lon: a.lon };
  const dt = Math.min(Math.max(now - a.updatedAt, 0), maxMs) / 1000;
  const distKm = (a.gsKt * KT_TO_KMH * dt) / 3600;
  const bearing = rad(a.track);
  const dLat = (distKm * Math.cos(bearing)) / EARTH_RADIUS_KM;
  const dLon = (distKm * Math.sin(bearing)) / (EARTH_RADIUS_KM * Math.cos(rad(a.lat)));
  return { lat: a.lat + (dLat * 180) / Math.PI, lon: a.lon + (dLon * 180) / Math.PI };
}

/** Points along the great circle between two coordinates, as [lat, lon] pairs (inclusive). */
export function greatCircle(lat1: number, lon1: number, lat2: number, lon2: number, n: number): [number, number][] {
  const toVec = (lat: number, lon: number): [number, number, number] =>
    [Math.cos(rad(lat)) * Math.cos(rad(lon)), Math.cos(rad(lat)) * Math.sin(rad(lon)), Math.sin(rad(lat))];
  const a = toVec(lat1, lon1), b = toVec(lat2, lon2);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = Math.sin(omega);
    const ka = s < 1e-9 ? 1 - t : Math.sin((1 - t) * omega) / s;
    const kb = s < 1e-9 ? t : Math.sin(t * omega) / s;
    const x = ka * a[0] + kb * b[0], y = ka * a[1] + kb * b[1], z = ka * a[2] + kb * b[2];
    out.push([(Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI]);
  }
  return out;
}
