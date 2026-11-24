# SkyMap

Live air traffic on a real map, rendered with PixiJS.

- **Aircraft**: real-time ADS-B positions from [adsb.fi](https://adsb.fi)'s open API (no key). The visible area is split into up to 6 queries, refreshed every ~6 s; positions are dead-reckoned between updates so planes glide.
- **Airports**: ~4,700 large/medium airports from [OurAirports](https://ourairports.com) (public domain), bundled in `src/data/airports.json`.
- **Map**: [Leaflet](https://leafletjs.com) with Esri's Dark Gray basemap handles pan/zoom. A transparent **PixiJS** canvas on top draws airports and aircraft (coloured by altitude, rotated by track).
- **Routes**: clicking an aircraft looks up its scheduled departure/arrival from adsb.lol's [standing data](https://vrs-standing-data.adsb.lol) (static, CORS-enabled, no proxy needed) and draws the great-circle line: flown part solid, remaining part dashed. It is schedule data keyed by callsign, so it can be missing or wrong; a route is ignored when the plane is more than 250 km away from it.
- **Filters**: aircraft are classified as commercial, cargo, private, military, helicopter or other (`src/services/classify.ts`) from the feed's military flag, ADS-B emitter category, aircraft type, callsign (airline designator vs registration) and operator name, plus a list of cargo airlines. Click a chip to toggle a kind (Ctrl+click to show only that kind); other planes are dimmed, not hidden. It is a heuristic: charter/air-taxi and cargo airlines flying passenger planes (or the reverse) can be misclassified. Ground vehicles and tower beacons in the feed are dropped.
- **Airport flights**: selecting an airport draws the scheduled departures (amber) and arrivals (cyan) of every tracked plane. Long-haul flights are far outside the view, so a background scan also samples the busiest great-circle corridors towards far-away large airports (up to 40 queries, ~45 s, with progress in the airport panel). Routes are cached for 6 h (30 min when missing); a finished scan is reused for 5 min and each plane it found expires after 15 min. Expired routes and older scans are shown immediately and refreshed in the background (stale-while-revalidate).
- Click an aircraft (live details, trail, route, nearest airport, follow mode) or an airport (info, traffic within 30 km). Panels are draggable.

## Running

```sh
npm install
npm run dev
```

Open the URL Vite prints .

### Why a proxy?

adsb.fi (like adsb.lol, OpenSky and airplanes.live) sends no CORS headers, so browsers can't call it directly. In dev and `npm run preview`, Vite proxies `/api/adsb/*` to `https://opendata.adsb.fi/api/*` (see `vite.config.js`).

**Production on shared PHP hosting (cPanel)**: the build ships `public/api/adsb.php` + `.htaccess`, a PHP port of the proxy with a 5 s / 2 min file cache. Nothing else to deploy: build and upload `dist/` to the subdomain's document root (the `Build and Deploy to FTP` workflow does it; point its `FTP_*` secrets at an FTP account whose home is the subdomain's folder).

**Alternative** (static hosting without PHP), deploy the caching proxy in `worker/` (a Cloudflare Worker) and set `VITE_ADSB_API` at build time:

```sh
cd worker && npx wrangler deploy        # prints https://skymap-proxy.<you>.workers.dev
cd .. && VITE_ADSB_API=https://skymap-proxy.<you>.workers.dev npm run build
```

The worker adds the missing CORS headers and caches responses at the edge, shared by all users: live-view queries for 5 s, corridor-scan queries (`?cache=long`) for 2 min. Corridor cells are the same for every user of an airport, so after the first visitor's scan the others are served from cache. Errors are never cached, and only the point-query path is proxied. Set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to restrict CORS to your site.

The API is rate-limited to about 1 request/second per IP; the app stays under that per user, and the shared cache keeps the worker's own request rate low.

**Browser cache**: routes (7 days, stale ones are shown and refreshed) and the last 4 airport scans (15 min per plane) are also kept in localStorage, so a reload doesn't start from scratch.

## Refreshing the airport data

```sh
node scripts/build-airports.mjs
```

## Scripts

- `npm run dev` – dev server
- `npm run build` – production build to `dist/`
- `npm run preview` – serve the production build (with the same dev proxy)

## Stack

React, PixiJS 7, Leaflet, TypeScript, Vite, MUI, react-draggable.

## License

MIT. Map tiles © Esri; map data © OpenStreetMap contributors; airport data from OurAirports.
