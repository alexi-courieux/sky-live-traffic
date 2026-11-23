import { FC, ReactNode, useRef } from 'react';
import { Box, Button, Card, CardContent, Chip, IconButton, LinearProgress, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import Draggable from 'react-draggable';
import type { Aircraft, Airport } from '../models.ts';
import { distanceKm, ftToM, ktToKmh } from '../geo.ts';
import { airportLabel, nearestAirport } from '../services/airports.ts';
import type { AirportFlight, Route } from '../services/routes.ts';
import type { ScanCell } from '../services/corridors.ts';
import { KIND_LABELS } from '../services/classify.ts';
import type { AircraftStore } from '../services/adsb.ts';

const Row: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, py: 0.25 }}>
    <Typography variant="body2" color="text.secondary">{label}</Typography>
    <Typography variant="body2" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{children}</Typography>
  </Box>
);

const Panel: FC<{ title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode }> = ({ title, subtitle, onClose, children }) => {
  const nodeRef = useRef<HTMLDivElement>(null);
  return (
    <Draggable nodeRef={nodeRef} handle=".panel-handle" cancel="button">
      <Card ref={nodeRef} sx={{ width: 320, maxWidth: '100%', pointerEvents: 'auto' }}>
        <CardContent sx={{ position: 'relative', p: 2, '&:last-child': { pb: 2 } }}>
          <IconButton aria-label="close" size="small" onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
          <Box className="panel-handle" sx={{ cursor: 'move', pr: 4, mb: 1 }}>
            <Typography variant="h6" component="div" noWrap>{title}</Typography>
            {subtitle && <Typography variant="body2" color="text.secondary" noWrap>{subtitle}</Typography>}
          </Box>
          {children}
        </CardContent>
      </Card>
    </Draggable>
  );
};

const flightLevel = (a: Aircraft) => (a.onGround ? 'Ground' : `FL${String(Math.round(a.altFt / 100)).padStart(3, '0')}`);

interface AircraftPanelProps {
  aircraft: Aircraft;
  route: Route | null;
  routeLoading: boolean;
  following: boolean;
  onToggleFollow: () => void;
  onSelectAirport: (icao: string) => void;
  onClose: () => void;
}

export const AircraftPanel: FC<AircraftPanelProps> = ({ aircraft: a, route, routeLoading, following, onToggleFollow, onSelectAirport, onClose }) => {
  const nearest = nearestAirport(a.lat, a.lon);
  const vrate = Math.abs(a.vRateFpm) < 64 ? 'level' : `${a.vRateFpm > 0 ? '+' : ''}${Math.round(a.vRateFpm)} ft/min`;

  return (
    <Panel
      title={a.callsign || a.hex.toUpperCase()}
      subtitle={[KIND_LABELS[a.kind], a.type, a.registration].filter(Boolean).join(' · ') || `ICAO24 ${a.hex}`}
      onClose={onClose}
    >
      <Row label="Altitude">
        {a.onGround ? 'On ground' : `${Math.round(a.altFt).toLocaleString()} ft (${flightLevel(a)})`}
      </Row>
      {!a.onGround && <Row label="">{Math.round(ftToM(a.altFt)).toLocaleString()} m</Row>}
      <Row label="Ground speed">{Math.round(a.gsKt)} kt ({Math.round(ktToKmh(a.gsKt))} km/h)</Row>
      <Row label="Track">{Math.round(a.track)}°</Row>
      <Row label="Vertical rate">{vrate}</Row>
      <Row label="Squawk">{a.squawk || '—'}</Row>
      <Row label="Position">{a.lat.toFixed(3)}, {a.lon.toFixed(3)}</Row>
      <Row label="ICAO24">{a.hex}</Row>

      <Box sx={{ mt: 1.5 }}>
        {routeLoading ? (
          <Typography variant="body2" color="text.secondary">Looking up route…</Typography>
        ) : route ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            {[['Departure', route.airports[0]], ['Arrival', route.airports[route.airports.length - 1]]].map(([label, ap]) => {
              const airport = ap as Route['airports'][number];
              return (
                <Button key={label as string} size="small" sx={{ textTransform: 'none', justifyContent: 'flex-start', textAlign: 'left' }}
                  onClick={() => onSelectAirport(airport.icao)}>
                  {label as string}: {airport.name} ({airport.iata || airport.icao})
                </Button>
              );
            })}
            <Typography variant="caption" color="text.secondary">Scheduled route for this callsign; the actual flight may differ.</Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">Route unknown</Typography>
        )}
      </Box>

      <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
        {nearest && (
          <Chip
            clickable
            size="small"
            onClick={() => onSelectAirport(nearest.airport.icao)}
            label={`Near ${airportLabel(nearest.airport)} · ${Math.round(nearest.distKm)} km`}
          />
        )}
        <Chip
          clickable
          size="small"
          color={following ? 'primary' : 'default'}
          onClick={onToggleFollow}
          label={following ? 'Following' : 'Follow'}
        />
      </Box>
    </Panel>
  );
};

interface AirportPanelProps {
  airport: Airport;
  store: AircraftStore;
  flights: AirportFlight[];
  flightsLoading: boolean;
  /** Progress of the long-haul corridor scan */
  scan: { cells: ScanCell[]; found: number; refreshing: boolean } | null;
  onClose: () => void;
}

export const AirportPanel: FC<AirportPanelProps> = ({ airport, store, flights, flightsLoading, scan, onClose }) => {
  const scanDone = scan ? scan.cells.filter((c) => c.state !== 'pending').length : 0;
  const scanTotal = scan?.cells.length ?? 0;
  const scanning = !!scan && scanDone < scanTotal;
  const departures = flights.filter((f) => f.dir === 'dep').length;
  const arrivals = flights.length - departures;
  let ground = 0, airborne = 0;
  for (const a of store.values()) {
    if (Math.abs(a.lat - airport.lat) > 0.5 || Math.abs(a.lon - airport.lon) > 0.8) continue;
    if (distanceKm(a.lat, a.lon, airport.lat, airport.lon) > 30) continue;
    if (a.onGround) ground++; else airborne++;
  }

  return (
    <Panel
      title={airport.name}
      subtitle={[airport.iata, airport.icao].filter(Boolean).join(' / ')}
      onClose={onClose}
    >
      <Row label="Location">{[airport.city, airport.country].filter(Boolean).join(', ')}</Row>
      <Row label="Elevation">{airport.elevationFt.toLocaleString()} ft ({Math.round(ftToM(airport.elevationFt))} m)</Row>
      <Row label="Position">{airport.lat.toFixed(4)}, {airport.lon.toFixed(4)}</Row>
      <Row label="Aircraft within 30 km">{airborne} airborne · {ground} on ground</Row>
      <Row label="Scheduled flights">
        {flightsLoading ? 'Looking up routes…' : (
          <>
            <span style={{ color: '#fbbf24' }}>{departures} departing</span> · <span style={{ color: '#22d3ee' }}>{arrivals} arriving</span>
          </>
        )}
      </Row>
      {scan && scanTotal > 0 && (
        <Box sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary" component="div">
            {scanning
              ? scan.refreshing
                ? `Showing earlier results · refreshing ${scanDone}/${scanTotal}…`
                : `Scanning long-haul corridors ${scanDone}/${scanTotal} (${scanTotal - scanDone} s left)…`
              : `Long-haul scan complete · ${scan.found.toLocaleString()} aircraft checked`}
          </Typography>
          <LinearProgress variant="determinate" value={(scanDone / scanTotal) * 100} sx={{ height: 3, borderRadius: 1, mt: 0.5, opacity: scanning ? 1 : 0.4 }} />
        </Box>
      )}
    </Panel>
  );
};
