/** Small localStorage helpers: every access is guarded, since storage can be missing, blocked or full. */

export function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const timers = new Map<string, number>();

/** Writes `build()` to storage after a short delay; calls in between collapse into one write. */
export function saveJsonLater(key: string, build: () => unknown, delayMs = 2000) {
  if (timers.has(key)) return;
  timers.set(key, window.setTimeout(() => {
    timers.delete(key);
    try {
      localStorage.setItem(key, JSON.stringify(build()));
    } catch { /* quota exceeded or storage unavailable: the in-memory cache still works */ }
  }, delayMs));
}
