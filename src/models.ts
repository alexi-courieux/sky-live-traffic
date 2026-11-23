export interface Airport {
  icao: string;
  iata: string;
  name: string;
  lat: number;
  lon: number;
  elevationFt: number;
  /** large_airport in OurAirports, otherwise medium_airport */
  isLarge: boolean;
  country: string;
  city: string;
}

export type AircraftKind = 'commercial' | 'cargo' | 'private' | 'military' | 'helicopter' | 'other';

export interface Aircraft {
  hex: string;
  callsign: string;
  registration: string;
  type: string;
  kind: AircraftKind;
  /** Operator name from the aircraft database, when known */
  operator: string;
  lat: number;
  lon: number;
  /** Barometric altitude in feet (0 when on the ground) */
  altFt: number;
  onGround: boolean;
  /** Ground speed in knots */
  gsKt: number;
  /** True track over ground, degrees clockwise from north */
  track: number;
  /** Vertical rate in ft/min */
  vRateFpm: number;
  squawk: string;
  /** Timestamp (ms) the position was actually valid */
  updatedAt: number;
  /** Recent reported positions, oldest first, as [lat, lon] */
  trail: [number, number][];
}
