import { FC, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { SkyOverlay, HitResult } from '../pixi/SkyOverlay.ts';
import { AircraftStore, fetchPoint, planQueries } from '../services/adsb.ts';
import { airports } from '../services/airports.ts';
import type { AirportFlight, Route } from '../services/routes.ts';
import type { AircraftKind } from '../models.ts';

export interface FeedStatus {
  state: 'loading' | 'live' | 'error';
  message?: string;
  lastUpdate: number | null;
  /** True when this is a rescan after moving the map, not the first load. */
  rescan?: boolean;
  /** Present while a scan with per-sector feedback is running. */
  progress?: { done: number; total: number };
}

interface MapViewProps {
  store: AircraftStore;
  selectedHex: string | null;
  selectedIcao: string | null;
  showAirports: boolean;
  radar: boolean;
  route: Route | null;
  flights: AirportFlight[];
  kinds: ReadonlySet<AircraftKind>;
  onSelect: (hit: HitResult | null) => void;
  onStatus: (status: FeedStatus) => void;
  onUserPan: () => void;
  onMapReady: (map: L.Map) => void;
}

/** Gap between two queries; adsb.fi allows 1 request per second. */
const QUERY_GAP_MS = 1100;
const CYCLE_MS = 6000;

const MapView: FC<MapViewProps> = (props) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapElRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SkyOverlay | null>(null);
  // Always call the latest callbacks without re-creating the map.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const map = L.map(mapElRef.current!, {
      center: [48.5, 6],
      zoom: 6,
      minZoom: 3,
      maxZoom: 12,
      zoomAnimation: false, // keeps the Pixi overlay in lockstep with the tiles
      zoomControl: false,
      worldCopyJump: false,
      maxBounds: [[-85, -180], [85, 180]],
      maxBoundsViscosity: 1,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    const esri = (layer: string) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${layer}/MapServer/tile/{z}/{y}/{x}`;
    L.tileLayer(esri('World_Dark_Gray_Base'), {
      attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors | Aircraft: <a href="https://adsb.fi">adsb.fi</a> | Airports: <a href="https://ourairports.com">OurAirports</a>',
      maxNativeZoom: 16,
      maxZoom: 16,
    }).addTo(map);
    L.tileLayer(esri('World_Dark_Gray_Reference'), { maxNativeZoom: 16, maxZoom: 16 }).addTo(map);

    const overlay = new SkyOverlay(hostRef.current!, map, propsRef.current.store, airports);
    overlayRef.current = overlay;
    overlay.setSelection(propsRef.current.selectedHex, propsRef.current.selectedIcao);
    overlay.setShowAirports(propsRef.current.showAirports);
    overlay.setRadar(propsRef.current.radar);
    overlay.setRoute(propsRef.current.route);
    overlay.setAirportFlights(propsRef.current.flights);    overlay.setKindFilter(propsRef.current.kinds);

    map.on('click', (e) => {
      propsRef.current.onSelect(overlay.hitTest(e.containerPoint.x, e.containerPoint.y));
    });
    map.on('mousemove', (e) => {
      const hit = overlay.hitTest(e.containerPoint.x, e.containerPoint.y);
      map.getContainer().style.cursor = hit ? 'pointer' : '';
    });
    map.on('dragstart', () => propsRef.current.onUserPan());
    propsRef.current.onMapReady(map);

    // --- live data polling ---------------------------------------------------
    // A "cycle" queries every sector of the current view. Moving the map aborts the
    // running cycle and starts a new one for the new view straight away.
    const abort = new AbortController();
    let cycle = new AbortController();
    let wake: (() => void) | null = null;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => { clearTimeout(id); wake = null; resolve(); };
        const id = setTimeout(done, ms);
        wake = done;
      });

    const { store } = propsRef.current;
    let lastUpdate: number | null = null;
    let lastRequestAt = 0;
    let initial = true; // nothing loaded successfully yet
    let announce = true; // report per-sector progress to the UI
    let live = false;

    let debounce: number | undefined;
    map.on('moveend', () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        const b = map.getBounds();
        store.pruneOutside({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() });
        if (overlay.visibleAircraft() === 0) announce = true; // jumped somewhere empty: show the scan
        cycle.abort();
        wake?.();
      }, 400);
    });

    (async () => {
      while (!abort.signal.aborted) {
        cycle = new AbortController();
        const signal = cycle.signal;
        const b = map.getBounds();
        const queries = planQueries({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() });
        let failures = 0;
        let lastError = '';

        for (let i = 0; i < queries.length; i++) {
          // stay under the API's 1 request/second limit, even across restarted cycles
          const wait = lastRequestAt + QUERY_GAP_MS - Date.now();
          if (wait > 0) await sleep(wait);
          if (signal.aborted) break;

          const status = (state: FeedStatus['state'], done: number): FeedStatus => ({
            state, lastUpdate, rescan: !initial, progress: announce ? { done, total: queries.length } : undefined,
          });
          if (announce) propsRef.current.onStatus(status(live ? 'live' : 'loading', i));
          lastRequestAt = Date.now();
          try {
            store.upsert(await fetchPoint(queries[i], signal));
            lastUpdate = Date.now();
            live = true;
            propsRef.current.onStatus(status('live', i + 1));
          } catch (err) {
            if (abort.signal.aborted) return;
            if (signal.aborted) break;
            failures++;
            lastError = err instanceof Error ? err.message : String(err);
          }
        }

        if (abort.signal.aborted) return;
        if (signal.aborted) continue; // the view changed: restart immediately

        store.prune();
        if (failures === queries.length) {
          live = false;
          announce = initial;
          propsRef.current.onStatus({ state: 'error', message: lastError, lastUpdate });
          await sleep(10_000);
        } else {
          initial = false;
          announce = false;
          propsRef.current.onStatus({ state: 'live', lastUpdate });
          await sleep(CYCLE_MS);
        }
      }
    })();

    return () => {
      abort.abort();
      cycle.abort();
      wake?.();
      window.clearTimeout(debounce);
      overlay.destroy();
      overlayRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    overlayRef.current?.setSelection(props.selectedHex, props.selectedIcao);
  }, [props.selectedHex, props.selectedIcao]);

  useEffect(() => {
    overlayRef.current?.setKindFilter(props.kinds);
  }, [props.kinds]);

  useEffect(() => {
    overlayRef.current?.setRoute(props.route);
  }, [props.route]);

  useEffect(() => {
    overlayRef.current?.setAirportFlights(props.flights);
  }, [props.flights]);

  useEffect(() => {
    overlayRef.current?.setRadar(props.radar);
  }, [props.radar]);

  useEffect(() => {
    overlayRef.current?.setShowAirports(props.showAirports);
  }, [props.showAirports]);

  return (
    <div ref={hostRef} className="map-host">
      <div ref={mapElRef} className="map-el" />
    </div>
  );
};

export default MapView;
