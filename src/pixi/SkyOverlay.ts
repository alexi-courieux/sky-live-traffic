import * as PIXI from 'pixi.js';
import type L from 'leaflet';
import type { Aircraft, AircraftKind, Airport } from '../models.ts';
import { ALL_KINDS } from '../services/classify.ts';
import { extrapolate } from '../geo.ts';
import { airportLabel } from '../services/airports.ts';
import type { AircraftStore } from '../services/adsb.ts';
import { locateOnRoute, ROUTE_MAX_OFF_KM, type AirportFlight, type Route } from '../services/routes.ts';

export type HitResult =
  | { kind: 'aircraft'; hex: string }
  | { kind: 'airport'; icao: string };

const PLANE_HIT_RADIUS = 16;
const AIRPORT_HIT_RADIUS = 11;
const MAX_AIRPORT_LABELS = 120;
const MAX_PLANE_LABELS = 100;

// Altitude (ft) -> colour, interpolated between stops.
const ALT_STOPS: [number, number][] = [
  [0, 0xf5c451],
  [8000, 0x58d68d],
  [20000, 0x38bdf8],
  [32000, 0x818cf8],
  [42000, 0xe879f9],
];
const GROUND_COLOR = 0x8b95a5;

function altitudeColor(a: Aircraft): number {
  if (a.onGround) return GROUND_COLOR;
  const alt = a.altFt;
  if (alt <= ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for (let i = 1; i < ALT_STOPS.length; i++) {
    const [hi, cHi] = ALT_STOPS[i];
    if (alt <= hi) {
      const [lo, cLo] = ALT_STOPS[i - 1];
      const t = (alt - lo) / (hi - lo);
      const mix = (s: number) => Math.round(((cLo >> s) & 255) * (1 - t) + ((cHi >> s) & 255) * t);
      return (mix(16) << 16) | (mix(8) << 8) | mix(0);
    }
  }
  return ALT_STOPS[ALT_STOPS.length - 1][1];
}

const LABEL_STYLE = new PIXI.TextStyle({
  fontFamily: 'Roboto, sans-serif',
  fontSize: 11,
  fontWeight: '500',
  fill: 0xffffff,
  stroke: 0x0b1220,
  strokeThickness: 3,
});

function polyline(g: PIXI.Graphics, pts: [number, number][]) {
  if (pts.length < 2) return;
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
}

/** Dashed line in screen space; segments entirely off screen are skipped so zooming in stays cheap. */
function dashedPolyline(g: PIXI.Graphics, pts: [number, number][], dash: number, gap: number, w: number, h: number) {
  if (pts.length < 2) return;
  let draw = true;
  let left = dash;
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const offscreen = (x0 < 0 && x1 < 0) || (x0 > w && x1 > w) || (y0 < 0 && y1 < 0) || (y0 > h && y1 > h);
    if (offscreen) { g.moveTo(x1, y1); draw = true; left = dash; continue; }
    const len = Math.hypot(x1 - x0, y1 - y0);
    let t = 0;
    while (len - t > 1e-6) {
      const step = Math.min(left, len - t);
      t += step;
      left -= step;
      const x = x0 + ((x1 - x0) * t) / len, y = y0 + ((y1 - y0) * t) / len;
      if (draw) g.lineTo(x, y); else g.moveTo(x, y);
      if (left <= 1e-6) { draw = !draw; left = draw ? dash : gap; }
    }
  }
}

/**
 * Draws airports and live aircraft with PixiJS on a transparent canvas that sits on
 * top of a Leaflet map. Leaflet owns pan/zoom; every frame we project lat/lon to screen.
 */
export class SkyOverlay {
  private app: PIXI.Application;
  private planeTexture: PIXI.Texture;

  private routeGfx = new PIXI.Graphics();
  private routeLabelLayer = new PIXI.Container();
  private routeLabels: PIXI.Text[] = [];
  private route: Route | null = null;
  private trailGfx = new PIXI.Graphics();
  private airportGfx = new PIXI.Graphics();
  private airportLabelLayer = new PIXI.Container();
  private planeLayer = new PIXI.Container();
  private dimLayer = new PIXI.Container(); // aircraft filtered out, drawn faintly underneath
  private enabledKinds: ReadonlySet<AircraftKind> = new Set(ALL_KINDS);
  private selectionGfx = new PIXI.Graphics();
  private planeLabelLayer = new PIXI.Container();

  private planeSprites = new Map<string, PIXI.Sprite>();
  private airportLabels: PIXI.Text[] = [];
  private planeLabels: PIXI.Text[] = [];

  private planeHits: { hex: string; x: number; y: number }[] = [];
  private airportHits: { icao: string; x: number; y: number }[] = [];

  private airportsDirty = true;
  private resizeObserver: ResizeObserver;

  // Radar shown while waiting for the feed; once data arrives one more sweep reveals the planes.
  private radarGfx = new PIXI.Graphics();
  private radarWanted = false;
  private radarAlpha = 0;
  private sweep = 0; // radians, clockwise from north
  private sweepStep = 0; // radians travelled this frame
  private revealTravel = -1; // -1 = reveal sweep not started
  private revealDone = false;
  private revealed = new Map<string, number>(); // hex -> time the sweep reached it

  private selectedHex: string | null = null;
  private selectedIcao: string | null = null;
  private showAirports = true;

  // Lines for every plane departing from / arriving at the selected airport (redrawn only when needed).
  private flightsGfx = new PIXI.Graphics();
  private flights: AirportFlight[] = [];
  private flightsDirty = true;
  private flightsDrawnAt = 0;

  private readonly onViewChange = () => { this.airportsDirty = true; this.flightsDirty = true; };

  constructor(
    host: HTMLElement,
    private map: L.Map,
    private store: AircraftStore,
    private airports: Airport[],
  ) {
    this.app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      width: host.clientWidth,
      height: host.clientHeight,
    });
    const canvas = this.app.view as HTMLCanvasElement;
    canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:500;';
    host.appendChild(canvas);

    this.planeTexture = this.buildPlaneTexture();

    this.app.stage.addChild(
      this.radarGfx, this.flightsGfx, this.routeGfx, this.trailGfx, this.airportGfx, this.airportLabelLayer,
      this.dimLayer, this.planeLayer, this.selectionGfx, this.planeLabelLayer, this.routeLabelLayer,
    );

    map.on('move zoom resize', this.onViewChange);
    this.resizeObserver = new ResizeObserver(() => {
      this.app.renderer.resize(host.clientWidth, host.clientHeight);
      this.airportsDirty = true;
    });
    this.resizeObserver.observe(host);

    this.app.ticker.add(this.frame);
  }

  setSelection(hex: string | null, icao: string | null) {
    this.selectedHex = hex;
    this.selectedIcao = icao;
    this.airportsDirty = true;
  }

  /** Number of aircraft currently on screen. */
  visibleAircraft(): number {
    return this.planeHits.length;
  }

  /** True while the feed is loading, rescanning after a move, or failing. */
  setRadar(on: boolean) {
    this.radarWanted = on;
  }

  setKindFilter(enabled: ReadonlySet<AircraftKind>) {
    this.enabledKinds = enabled;
  }

  setRoute(route: Route | null) {
    this.route = route;
  }

  setAirportFlights(flights: AirportFlight[]) {
    this.flights = flights;
    this.flightsDirty = true;
  }

  setShowAirports(show: boolean) {
    this.showAirports = show;
    this.airportsDirty = true;
  }

  /** Finds what is under a screen point (container pixels). Aircraft win over airports. */
  hitTest(x: number, y: number): HitResult | null {
    let best: HitResult | null = null;
    let bestDist = PLANE_HIT_RADIUS ** 2;
    for (const p of this.planeHits) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestDist) { bestDist = d; best = { kind: 'aircraft', hex: p.hex }; }
    }
    if (best) return best;
    bestDist = AIRPORT_HIT_RADIUS ** 2;
    for (const a of this.airportHits) {
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bestDist) { bestDist = d; best = { kind: 'airport', icao: a.icao }; }
    }
    return best;
  }

  destroy() {
    this.map.off('move zoom resize', this.onViewChange);
    this.resizeObserver.disconnect();
    this.app.ticker.remove(this.frame);
    this.app.destroy(true, { children: true, texture: true, baseTexture: true });
  }

  // ---------------------------------------------------------------------------

  private buildPlaneTexture(): PIXI.Texture {
    const half: [number, number][] = [
      [0, -30], [4, -20], [4, -6], [30, 8], [30, 14], [4, 8], [3, 22], [11, 28], [11, 32], [0, 29],
    ];
    const pts = [...half, ...half.slice(1, -1).reverse().map(([x, y]): [number, number] => [-x, y])];
    const g = new PIXI.Graphics();
    g.lineStyle(3, 0x0b1220, 0.95);
    g.beginFill(0xffffff);
    g.drawPolygon(pts.flat());
    g.endFill();
    const tex = this.app.renderer.generateTexture(g, { resolution: 2, region: new PIXI.Rectangle(-34, -36, 68, 72) });
    g.destroy();
    return tex;
  }

  private label(pool: PIXI.Text[], layer: PIXI.Container, i: number): PIXI.Text {
    let t = pool[i];
    if (!t) {
      t = new PIXI.Text('', LABEL_STYLE);
      t.resolution = 2;
      layer.addChild(t);
      pool[i] = t;
    }
    t.visible = true;
    return t;
  }

  private frame = () => {
    const now = Date.now();
    const zoom = this.map.getZoom();
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const margin = 40;
    const inView = (x: number, y: number) => x > -margin && x < w + margin && y > -margin && y < h + margin;

    if (this.airportsDirty) {
      this.drawAirports(zoom, inView);
      this.airportsDirty = false;
    }
    this.updateRadar(w, h);
    this.drawAircraft(now, zoom, inView);
    this.drawFlights(now);
    this.drawRoute(now);
  };

  /** Departures (amber) and arrivals (cyan): flown part solid, remaining part faint. */
  private drawFlights(now: number) {
    if (!this.flightsDirty && now - this.flightsDrawnAt < 1000) return; // planes move: refresh once a second
    this.flightsDirty = false;
    this.flightsDrawnAt = now;
    const g = this.flightsGfx;
    g.clear();
    const w = this.app.screen.width, h = this.app.screen.height;
    for (const f of this.flights) {
      const live = this.store.get(f.hex);
      // planes found by a corridor scan are not in the store: dead-reckon from the snapshot for longer
      const pos = live ? extrapolate(live, now) : extrapolate(f.aircraft, now, 20 * 60_000);
      // nearest sample on the leg = where the plane is along its route
      let idx = 0, best = Infinity;
      f.pts.forEach(([lat, lon], i) => {
        const d = (lat - pos.lat) ** 2 + ((lon - pos.lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
        if (d < best) { best = d; idx = i; }
      });
      const colour = f.dir === 'dep' ? 0xfbbf24 : 0x22d3ee;
      const here = this.map.latLngToContainerPoint([pos.lat, pos.lon]);
      const project = (pts: [number, number][]): [number, number][][] => {
        const runs: [number, number][][] = [];
        let run: [number, number][] = [];
        pts.forEach(([lat, lon], i) => {
          if (i > 0 && Math.abs(lon - pts[i - 1][1]) > 180) { runs.push(run); run = []; }
          const p = this.map.latLngToContainerPoint([lat, lon]);
          run.push([p.x, p.y]);
        });
        runs.push(run);
        return runs;
      };
      const flown = project(f.pts.slice(0, idx + 1));
      const ahead = project(f.pts.slice(idx));
      const onScreen = (r: [number, number][]) => r.some(([x, y]) => x > -50 && x < w + 50 && y > -50 && y < h + 50);
      g.lineStyle(1.5, colour, f.dir === 'dep' ? 0.35 : 0.8);
      flown.forEach((r, k) => { if (k === flown.length - 1) r.push([here.x, here.y]); if (onScreen(r)) polyline(g, r); });
      g.lineStyle(1.5, colour, f.dir === 'dep' ? 0.8 : 0.35);
      ahead.forEach((r, k) => { if (k === 0) r.unshift([here.x, here.y]); if (onScreen(r)) polyline(g, r); });
    }
  }

  private drawRoute(now: number) {
    const g = this.routeGfx;
    g.clear();
    let labelCount = 0;
    const a = this.selectedHex ? this.store.get(this.selectedHex) : undefined;
    const route = this.route;

    if (a && route) {
      const pos = extrapolate(a, now);
      const loc = locateOnRoute(route, pos.lat, pos.lon);
      if (loc.offKm <= ROUTE_MAX_OFF_KM) {
        const here = this.map.latLngToContainerPoint([pos.lat, pos.lon]);
        const proj = (pts: [number, number][]): [number, number][][] => {
          // split where the line wraps around the antimeridian
          const runs: [number, number][][] = [];
          let run: [number, number][] = [];
          pts.forEach(([lat, lon], i) => {
            if (i > 0 && Math.abs(lon - pts[i - 1][1]) > 180) { runs.push(run); run = []; }
            const p = this.map.latLngToContainerPoint([lat, lon]);
            run.push([p.x, p.y]);
          });
          runs.push(run);
          return runs;
        };
        const w = this.app.screen.width, h = this.app.screen.height;

        route.legs.forEach((leg, i) => {
          if (i !== loc.leg) {
            g.lineStyle(2, 0x94a3b8, 0.3);
            proj(leg).forEach((r) => dashedPolyline(g, r, 6, 6, w, h));
            return;
          }
          const flown = leg.slice(0, loc.index + 1);
          const ahead = leg.slice(loc.index + 1);
          g.lineStyle(2.5, 0x38bdf8, 0.7);
          proj(flown).forEach((r, k, all) => {
            if (k === all.length - 1) r.push([here.x, here.y]);
            polyline(g, r);
          });
          g.lineStyle(2.5, 0xffffff, 0.9);
          proj(ahead).forEach((r, k) => {
            if (k === 0) r.unshift([here.x, here.y]);
            dashedPolyline(g, r, 9, 7, w, h);
          });
        });

        route.airports.forEach((ap, i) => {
          const p = this.map.latLngToContainerPoint([ap.lat, ap.lon]);
          const end = i === 0 || i === route.airports.length - 1;
          g.lineStyle(2, 0xffffff, end ? 1 : 0.5);
          g.beginFill(0x0b1220, 0.9);
          g.drawCircle(p.x, p.y, end ? 6 : 4);
          g.endFill();
          if (p.x > -40 && p.x < w + 40 && p.y > -40 && p.y < h + 40) {
            const t = this.label(this.routeLabels, this.routeLabelLayer, labelCount++);
            const text = (i === 0 ? 'FROM ' : i === route.airports.length - 1 ? 'TO ' : '') + (ap.iata || ap.icao);
            if (t.text !== text) t.text = text;
            t.anchor.set(0.5, 1.4);
            t.position.set(p.x, p.y);
          }
        });
      }
    }
    for (let i = labelCount; i < this.routeLabels.length; i++) this.routeLabels[i].visible = false;
  }

  private updateRadar(w: number, h: number) {
    const dt = this.app.ticker.deltaMS;
    const FULL = Math.PI * 2;

    // First data has arrived: start one reveal sweep.
    if (!this.revealDone && this.revealTravel < 0 && this.store.size > 0) {
      this.revealTravel = 0;
    }
    const revealing = this.revealTravel >= 0 && !this.revealDone;
    // After the first reveal the radar only shows over an empty view (e.g. after jumping to another continent).
    const wanted = this.radarWanted && (!this.revealDone || this.planeHits.length === 0);
    const target = wanted || revealing ? 1 : 0;
    const delta = target - this.radarAlpha;
    this.radarAlpha += Math.sign(delta) * Math.min(Math.abs(delta), dt / 400);

    this.sweepStep = this.radarAlpha > 0 ? (dt / 2400) * FULL : 0; // one turn per 2.4 s
    this.sweep = (this.sweep + this.sweepStep) % FULL;
    if (revealing) {
      this.revealTravel += this.sweepStep;
      if (this.revealTravel >= FULL) this.revealDone = true;
    }

    const g = this.radarGfx;
    g.clear();
    if (this.radarAlpha <= 0) return;

    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42, col = 0x38bdf8, A = this.radarAlpha;
    g.lineStyle(1.5, col, 0.35 * A);
    for (let k = 1; k <= 3; k++) g.drawCircle(cx, cy, (R * k) / 3);
    g.moveTo(cx - R, cy); g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R); g.lineTo(cx, cy + R);

    const TRAIL = Math.PI / 2.5, N = 40;
    g.lineStyle(0);
    for (let i = 0; i < N; i++) {
      const a1 = this.sweep - (i * TRAIL) / N - Math.PI / 2;
      const a0 = a1 - TRAIL / N;
      g.beginFill(col, 0.28 * A * (1 - i / N) ** 2);
      g.moveTo(cx, cy);
      g.arc(cx, cy, R, a0, a1 + 0.002);
      g.lineTo(cx, cy);
      g.endFill();
    }
    const lead = this.sweep - Math.PI / 2;
    g.lineStyle(2, col, 0.9 * A);
    g.moveTo(cx, cy);
    g.lineTo(cx + R * Math.cos(lead), cy + R * Math.sin(lead));
  }

  private drawAirports(zoom: number, inView: (x: number, y: number) => boolean) {
    const g = this.airportGfx;
    g.clear();
    this.airportHits.length = 0;
    let labelCount = 0;

    if (this.showAirports && zoom >= 4) {
      const showMedium = zoom >= 7;
      const radius = 2.5 + (zoom - 4) * 0.45;
      const labelLarge = zoom >= 6;
      const labelAll = zoom >= 8;

      for (const a of this.airports) {
        if (!a.isLarge && !showMedium) continue;
        const p = this.map.latLngToContainerPoint([a.lat, a.lon]);
        if (!inView(p.x, p.y)) continue;

        g.lineStyle(1.5, 0x0b1220, 0.9);
        g.beginFill(a.isLarge ? 0xffd166 : 0xcbd5e1, 0.95);
        g.drawCircle(p.x, p.y, a.isLarge ? radius : radius * 0.7);
        g.endFill();
        this.airportHits.push({ icao: a.icao, x: p.x, y: p.y });

        if ((a.isLarge ? labelLarge : labelAll) && labelCount < MAX_AIRPORT_LABELS) {
          const t = this.label(this.airportLabels, this.airportLabelLayer, labelCount++);
          const text = airportLabel(a);
          if (t.text !== text) t.text = text;
          t.anchor.set(0.5, -0.9);
          t.position.set(p.x, p.y);
        }
      }
    }
    for (let i = labelCount; i < this.airportLabels.length; i++) this.airportLabels[i].visible = false;

    if (this.selectedIcao) {
      const a = this.airports.find((x) => x.icao === this.selectedIcao);
      if (a) {
        const p = this.map.latLngToContainerPoint([a.lat, a.lon]);
        g.lineStyle(2, 0xffffff, 1);
        g.drawCircle(p.x, p.y, 11);
      }
    }
  }

  private drawAircraft(now: number, zoom: number, inView: (x: number, y: number) => boolean) {
    const size = Math.min(Math.max(9 + zoom * 1.3, 12), 28);
    const scale = size / 64;
    const showCallsigns = zoom >= 8;
    const seen = new Set<string>();
    this.planeHits.length = 0;
    let labelCount = 0;

    let selectedPos: { x: number; y: number } | null = null;

    for (const a of this.store.values()) {
      const pos = extrapolate(a, now);
      const p = this.map.latLngToContainerPoint([pos.lat, pos.lon]);
      const visible = inView(p.x, p.y);
      let sprite = this.planeSprites.get(a.hex);

      if (!visible) {
        if (sprite) sprite.visible = false;
        seen.add(a.hex);
        continue;
      }
      if (!sprite) {
        sprite = new PIXI.Sprite(this.planeTexture);
        sprite.anchor.set(0.5);
        this.planeLayer.addChild(sprite);
        this.planeSprites.set(a.hex, sprite);
      }
      seen.add(a.hex);

      // Until the reveal sweep is over, a plane only appears when the radar beam reaches it.
      let flash = 0;
      if (!this.revealDone) {
        let t = this.revealed.get(a.hex);
        if (t === undefined && this.revealTravel >= 0) {
          const ang = (Math.atan2(p.x - this.app.screen.width / 2, -(p.y - this.app.screen.height / 2)) + 2 * Math.PI) % (2 * Math.PI);
          const passed = (this.sweep - ang + 2 * Math.PI) % (2 * Math.PI);
          if (passed <= this.sweepStep + 1e-6) { t = now; this.revealed.set(a.hex, t); }
        }
        if (t === undefined) { sprite.visible = false; continue; }
        flash = Math.max(0, 1 - (now - t) / 700);
      }

      const selected = a.hex === this.selectedHex;
      // Planes outside the active filter are dimmed: faint, behind the others, not clickable, no label.
      const active = selected || this.enabledKinds.has(a.kind);
      const layer = active ? this.planeLayer : this.dimLayer;
      if (sprite.parent !== layer) layer.addChild(sprite);

      sprite.visible = true;
      sprite.position.set(p.x, p.y);
      sprite.rotation = (a.track * Math.PI) / 180;
      sprite.scale.set(scale * (active ? 1 + flash * 1.2 : 0.75));
      sprite.tint = active ? altitudeColor(a) : GROUND_COLOR;
      sprite.alpha = active ? (a.onGround ? 0.7 : 1) : 0.16;
      if (active) this.planeHits.push({ hex: a.hex, x: p.x, y: p.y });

      if (selected) selectedPos = { x: p.x, y: p.y };

      if (active && (showCallsigns || selected) && a.callsign && labelCount < MAX_PLANE_LABELS) {
        const t = this.label(this.planeLabels, this.planeLabelLayer, labelCount++);
        if (t.text !== a.callsign) t.text = a.callsign;
        t.anchor.set(0.5, -0.9 - size / 40);
        t.position.set(p.x, p.y);
      }
    }
    for (let i = labelCount; i < this.planeLabels.length; i++) this.planeLabels[i].visible = false;

    for (const [hex, sprite] of this.planeSprites) {
      if (!seen.has(hex)) {
        sprite.destroy();
        this.planeSprites.delete(hex);
      }
    }

    // selection ring and trail
    this.selectionGfx.clear();
    this.trailGfx.clear();
    if (selectedPos) {
      this.selectionGfx.lineStyle(2, 0xffffff, 0.95);
      this.selectionGfx.drawCircle(selectedPos.x, selectedPos.y, size * 0.85);

      const a = this.store.get(this.selectedHex!);
      if (a && a.trail.length > 1) {
        const color = altitudeColor(a);
        this.trailGfx.lineStyle(2, color, 0.8);
        a.trail.forEach(([lat, lon], i) => {
          const tp = this.map.latLngToContainerPoint([lat, lon]);
          if (i === 0) this.trailGfx.moveTo(tp.x, tp.y);
          else this.trailGfx.lineTo(tp.x, tp.y);
        });
        this.trailGfx.lineTo(selectedPos.x, selectedPos.y);
      }
    }
  }
}
