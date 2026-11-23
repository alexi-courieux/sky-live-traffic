import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type L from 'leaflet';
import { Box, Chip, CssBaseline, FormControlLabel, Paper, Switch, ThemeProvider, Typography, createTheme } from '@mui/material';
import MapView, { FeedStatus } from './components/MapView.tsx';
import { AircraftPanel, AirportPanel } from './components/InfoPanel.tsx';
import { AircraftStore } from './services/adsb.ts';
import { airports } from './services/airports.ts';
import { extrapolate } from './geo.ts';
import { ALL_KINDS, KIND_LABELS } from './services/classify.ts';
import type { Aircraft, AircraftKind } from './models.ts';
import { fetchPoint } from './services/adsb.ts';
import { cachedScan, planCorridors, saveScan, type ScanCell } from './services/corridors.ts';
import { fetchAirportFlights, fetchRoute, locateOnRoute, ROUTE_MAX_OFF_KM, type AirportFlight, type Route } from './services/routes.ts';
import type { HitResult } from './pixi/SkyOverlay.ts';
import './App.css';

const theme = createTheme({
  palette: { mode: 'dark', primary: { main: '#38bdf8' }, background: { paper: 'rgba(15, 23, 42, 0.92)' } },
  typography: { fontFamily: 'Roboto, sans-serif' },
});

const BootLog: FC<{ status: FeedStatus }> = ({ status }) => {
  const { state, progress } = status;
  const line = (done: boolean, text: string, error = false) => (
    <Typography variant="caption" component="div" sx={{ color: error ? 'error.main' : done ? 'success.main' : 'text.secondary', fontFamily: 'monospace' }}>
      {error ? '✗' : done ? '✓' : '›'} {text}
    </Typography>
  );
  const connected = state === 'live' || (progress !== undefined && progress.done > 0);
  return (
    <Box sx={{ my: 0.5 }}>
      {line(true, `Airports loaded (${airports.length.toLocaleString()})`)}
      {state === 'error'
        ? line(false, 'Feed unreachable, retrying…', true)
        : line(connected, connected ? 'Feed connected' : 'Contacting feed…')}
      {state !== 'error' && connected && progress && progress.done < progress.total &&
        line(false, `Scanning sector ${progress.done + 1}/${progress.total}…`)}
    </Box>
  );
};

const App: FC = () => {
  const store = useMemo(() => new AircraftStore(), []);
  const mapRef = useRef<L.Map | null>(null);

  const [status, setStatus] = useState<FeedStatus>({ state: 'loading', lastUpdate: null });
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [selectedIcao, setSelectedIcao] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [showAirports, setShowAirports] = useState(true);
  const [routeState, setRouteState] = useState<{ callsign: string; route: Route | null } | null>(null);
  const [enabledKinds, setEnabledKinds] = useState<ReadonlySet<AircraftKind>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('skymap.kinds') ?? 'null') as AircraftKind[] | null;
      if (saved) return new Set(saved.filter((k) => ALL_KINDS.includes(k)));
    } catch { /* storage unavailable: use defaults */ }
    return new Set(ALL_KINDS);
  });
  const toggleKind = useCallback((kind: AircraftKind, only = false) => {
    setEnabledKinds((prev) => {
      const next = only ? new Set([kind]) : new Set(prev);
      if (!only) { if (next.has(kind)) next.delete(kind); else next.add(kind); }
      try { localStorage.setItem('skymap.kinds', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [, setTick] = useState(0);

  // Re-render once a second so panels and the status line follow the live data.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handleSelect = useCallback((hit: HitResult | null) => {
    if (!hit) return;
    if (hit.kind === 'aircraft') setSelectedHex(hit.hex);
    else setSelectedIcao(hit.icao);
  }, []);

  const selectAirport = useCallback((icao: string) => {
    const airport = airports.find((a) => a.icao === icao);
    setSelectedIcao(icao);
    if (airport) mapRef.current?.setView([airport.lat, airport.lon], Math.max(mapRef.current.getZoom(), 9), { animate: false });
    setFollowing(false);
  }, []);

  // Look up the scheduled route when an aircraft is selected.
  const selectedCallsign = selectedHex ? store.get(selectedHex)?.callsign ?? "" : "";
  useEffect(() => {
    if (!selectedCallsign) { setRouteState(null); return; }
    let cancelled = false;
    fetchRoute(selectedCallsign).then((route) => { if (!cancelled) setRouteState({ callsign: selectedCallsign, route }); });
    return () => { cancelled = true; };
  }, [selectedCallsign]);

  // Scheduled departures/arrivals of the selected airport, refreshed as new aircraft come into range.
  const [airportFlights, setAirportFlights] = useState<{ icao: string; flights: AirportFlight[] } | null>(null);
  const [scan, setScan] = useState<{ icao: string; cells: ScanCell[]; found: number; refreshing: boolean } | null>(null);
  useEffect(() => {
    const ap = selectedIcao ? airports.find((a) => a.icao === selectedIcao) : undefined;
    if (!ap) { setAirportFlights(null); setScan(null); return; }
    const abort = new AbortController();
    const cached = cachedScan(ap.icao);
    const extra = new Map<string, Aircraft>(cached.aircraft); // planes found by the corridor scan, outside the normal view
    let seq = 0, applied = 0;

    const refresh = () => {
      const mine = ++seq;
      const all = new Map(extra);
      for (const a of store.values()) all.set(a.hex, a); // the live store is fresher
      fetchAirportFlights(ap.icao, ap.lat, ap.lon, all.values()).then((flights) => {
        if (abort.signal.aborted || mine < applied) return;
        applied = mine;
        setAirportFlights({ icao: ap.icao, flights });
      });
    };
    refresh();
    const id = setInterval(refresh, 8000);

    // Look for long-haul traffic along the busiest corridors, one sector at a time.
    const cells: ScanCell[] = planCorridors(ap, airports).map((q) => ({ ...q, state: cached.fresh ? 'done' : 'pending' }));
    setScan({ icao: ap.icao, cells: [...cells], found: extra.size, refreshing: extra.size > 0 });
    (async () => {
      if (cached.fresh) return; // scanned a moment ago: reuse it
      for (let i = 0; i < cells.length && !abort.signal.aborted; i++) {
        try {
          for (const a of await fetchPoint(cells[i], abort.signal, true)) if (a.callsign.length >= 3) extra.set(a.hex, a);
          cells[i] = { ...cells[i], state: 'done' };
          refresh(); // lines appear as the scan goes
        } catch {
          if (abort.signal.aborted) return;
          cells[i] = { ...cells[i], state: 'failed' };
        }
        saveScan(ap.icao, extra, i === cells.length - 1);
        setScan({ icao: ap.icao, cells: [...cells], found: extra.size, refreshing: cached.aircraft.size > 0 });
      }
    })();

    return () => { abort.abort(); clearInterval(id); };
  }, [selectedIcao, store]);
  const flights = useMemo(
    () => (airportFlights && airportFlights.icao === selectedIcao ? airportFlights.flights : []),
    [airportFlights, selectedIcao],
  );
  const flightsLoading = !!selectedIcao && airportFlights?.icao !== selectedIcao;

  // Follow mode: keep the selected aircraft centred.
  useEffect(() => {
    if (!following || !selectedHex) return;
    const id = setInterval(() => {
      const a = store.get(selectedHex);
      if (!a || !mapRef.current) return;
      const p = extrapolate(a, Date.now());
      mapRef.current.setView([p.lat, p.lon], mapRef.current.getZoom(), { animate: false });
    }, 250);
    return () => clearInterval(id);
  }, [following, selectedHex, store]);

  const aircraft = selectedHex ? store.get(selectedHex) : undefined;
  const airport = selectedIcao ? airports.find((a) => a.icao === selectedIcao) : undefined;
  // Deselect an aircraft once it has left coverage (runs on every 1 s tick).
  useEffect(() => {
    if (selectedHex && !aircraft && store.size > 0) { setSelectedHex(null); setFollowing(false); }
  });

  const routeLoading = !!selectedCallsign && routeState?.callsign !== selectedCallsign;
  const rawRoute = routeState?.callsign === selectedCallsign ? routeState.route : null;
  // Ignore a route the aircraft is clearly not flying (callsigns get reused).
  const route = rawRoute && aircraft && locateOnRoute(rawRoute, aircraft.lat, aircraft.lon).offKm <= ROUTE_MAX_OFF_KM ? rawRoute : null;
  const kindCounts = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<AircraftKind, number>;
  for (const a of store.values()) kindCounts[a.kind]++;
  const age = status.lastUpdate ? Math.round((Date.now() - status.lastUpdate) / 1000) : null;
  const { rescan, progress } = status;
  const scanLabel = rescan && progress ? `Scanning sector ${Math.min(progress.done + 1, progress.total)}/${progress.total}…` : null;
  const zoom = mapRef.current?.getZoom() ?? 6;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MapView
        store={store}
        selectedHex={selectedHex}
        selectedIcao={selectedIcao}
        showAirports={showAirports}
        route={route}
        flights={flights}
        kinds={enabledKinds}
        radar={status.state !== 'live' || status.progress !== undefined}
        onSelect={handleSelect}
        onStatus={setStatus}
        onUserPan={() => setFollowing(false)}
        onMapReady={(map) => { mapRef.current = map; }}
      />

      <Paper className="hud hud-top" elevation={4}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>SkyMap</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {status.state === 'error' ? (
            <Chip size="small" color="error" label={`Feed unavailable: ${status.message}`} />
          ) : status.state === 'loading' ? (
            <Chip size="small" label={scanLabel ?? "Connecting…"} />
          ) : status.progress ? (
            <Chip size="small" color="success" variant="outlined" label={`${scanLabel ?? "LIVE"} · ${store.size.toLocaleString()} aircraft`} />
          ) : (
            <Chip size="small" color="success" variant="outlined" label={`LIVE · ${store.size.toLocaleString()} aircraft${age !== null ? ` · ${age}s ago` : ''}`} />
          )}
        </Box>
        {!status.rescan && (status.progress || status.state !== 'live') && <BootLog status={status} />}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, maxWidth: 300, my: 0.5 }}>
          {ALL_KINDS.map((kind) => (
            <Chip
              key={kind}
              size="small"
              clickable
              title="Click to toggle, Ctrl+click to show only this kind"
              color={enabledKinds.has(kind) ? 'primary' : 'default'}
              variant={enabledKinds.has(kind) ? 'filled' : 'outlined'}
              onClick={(e) => toggleKind(kind, e.ctrlKey || e.metaKey)}
              label={`${KIND_LABELS[kind]} · ${kindCounts[kind]}`}
            />
          ))}
        </Box>
        <FormControlLabel
          control={<Switch size="small" checked={showAirports} onChange={(e) => setShowAirports(e.target.checked)} />}
          label={<Typography variant="body2">Airports</Typography>}
        />
        {zoom < 5 && <Typography variant="caption" color="text.secondary">Zoom in to load more traffic</Typography>}
      </Paper>

      <Box className="hud hud-panels">
        {aircraft && (
          <AircraftPanel
            aircraft={aircraft}
            route={route}
            routeLoading={routeLoading}
            following={following}
            onToggleFollow={() => setFollowing((f) => !f)}
            onSelectAirport={selectAirport}
            onClose={() => { setSelectedHex(null); setFollowing(false); }}
          />
        )}
        {airport && <AirportPanel airport={airport} store={store} flights={flights} flightsLoading={flightsLoading} scan={scan && scan.icao === selectedIcao ? scan : null} onClose={() => setSelectedIcao(null)} />}
      </Box>
    </ThemeProvider>
  );
};

export default App;
