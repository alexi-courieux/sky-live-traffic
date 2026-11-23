/**
 * Caching proxy for the adsb.fi open API (Cloudflare Worker).
 *
 * - adds the CORS headers the API lacks, so the static app can call it from the browser
 * - caches responses at the edge, shared by all users, so upstream sees far fewer requests
 *   (the API allows ~1 request/second per IP, and every visitor would otherwise count against it)
 *
 * Only the point query is proxied: /v2/lat/{lat}/lon/{lon}/dist/{nm}
 *   ?cache=long  -> kept 2 min (corridor scans: identical URLs for every user of an airport, positions drift slowly)
 *   otherwise    -> kept 5 s   (live view)
 */
const UPSTREAM = 'https://opendata.adsb.fi/api';
const POINT_PATH = /^\/v2\/lat\/-?\d{1,2}(\.\d+)?\/lon\/-?\d{1,3}(\.\d+)?\/dist\/\d{1,3}$/;
const SHORT_TTL = 5;
const LONG_TTL = 120;

export default {
  async fetch(request, env, ctx) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    if (!POINT_PATH.test(url.pathname)) return new Response('Not found', { status: 404, headers: cors });

    const ttl = url.searchParams.get('cache') === 'long' ? LONG_TTL : SHORT_TTL;
    const cache = caches.default;
    const key = new Request(`${url.origin}${url.pathname}?ttl=${ttl}`);

    let res = await cache.match(key);
    if (!res) {
      const upstream = await fetch(UPSTREAM + url.pathname, { headers: { 'User-Agent': 'skymap-proxy' } });
      res = new Response(upstream.body, upstream);
      // never cache errors (a 429 must not be served to everyone for minutes)
      res.headers.set('Cache-Control', upstream.ok ? `public, max-age=${ttl}` : 'no-store');
      if (upstream.ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
