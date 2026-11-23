import type { AircraftKind } from '../models.ts';

export const KIND_LABELS: Record<AircraftKind, string> = {
  commercial: 'Commercial',
  cargo: 'Cargo',
  private: 'Private',
  military: 'Military',
  helicopter: 'Helicopter',
  other: 'Other',
};

export const ALL_KINDS = Object.keys(KIND_LABELS) as AircraftKind[];

export interface ClassifyInput {
  callsign: string;
  /** ICAO type designator, e.g. B738 */
  type: string;
  /** ADS-B emitter category, e.g. A3 */
  category: string;
  /** Bit 0 = military in the community aircraft database */
  dbFlags: number;
  /** Operator name from the database, when known */
  operator: string;
}

/** ICAO airline designators of dedicated cargo operators (their callsigns start with these). */
const CARGO_PREFIXES = new Set([
  'FDX', 'UPS', 'GTI', 'CLX', 'DHK', 'DHL', 'BCS', 'PAC', 'ABW', 'CKS', 'KYE', 'NCA', 'CAO', 'CKK',
  'CSS', 'TAY', 'ABR', 'SQC', 'BOX', 'GEC', 'MPH', 'ICV', 'AHK', 'ABX', 'ATN', 'CWC', 'NPT', 'FPO',
  'CJT', 'EIA', 'SRR', 'AJK', 'MTN', 'NCR', 'SOO', 'RAX', 'GSS', 'AMF',
]);

const CARGO_OPERATOR = /FEDERAL EXPRESS|UNITED PARCEL|\bUPS\b|\bDHL\b|CARGO|FREIGHT|ATLAS AIR|KALITTA|AIR TRANSPORT INTERNATIONAL|ABX AIR|POLAR AIR|AIRBRIDGE/i;

/** Types that are (almost) only built or used as freighters. */
const FREIGHTER_TYPES = new Set(['B77L', 'A124', 'A225', 'IL76']);

/** Airlines that also fly passenger 777-200LRs under the same B77L type code as the 777F. */
const PASSENGER_B77L_AIRLINES = new Set(['UAE', 'QTR', 'ETD', 'ETH', 'AIC', 'THA', 'PIA']);

/** Passenger airliner type codes, used when the callsign is missing or unusual. */
const AIRLINER_TYPE = /^(A[23]\d[0-9A-Z]|B7\d[0-9A-Z]|B3\dM|BCS[13]|E1\d\d|E7[05][LS]|E19[05]|CRJ\d|SU95|C919|MC21)$/;

/** Business jets and high-end turboprops/singles, which airlines do not fly. */
const BIZ_TYPES = new Set([
  'C25A', 'C25B', 'C25C', 'C25M', 'C500', 'C501', 'C510', 'C525', 'C550', 'C560', 'C56X', 'C650', 'C680', 'C68A', 'C700', 'C750',
  'E35L', 'E50P', 'E545', 'E550', 'E55P', 'F2TH', 'F900', 'FA10', 'FA20', 'FA50', 'FA5X', 'FA6X', 'FA7X', 'FA8X',
  'GL5T', 'GL6T', 'GL7T', 'GLEX', 'GLF2', 'GLF3', 'GLF4', 'GLF5', 'GLF6', 'GALX', 'G150', 'G200', 'G280',
  'H25A', 'H25B', 'H25C', 'HA4T', 'HDJT', 'LJ23', 'LJ24', 'LJ25', 'LJ28', 'LJ31', 'LJ35', 'LJ36', 'LJ40', 'LJ45', 'LJ55', 'LJ60', 'LJ70', 'LJ75',
  'CL30', 'CL35', 'CL60', 'BE40', 'PRM1', 'PC12', 'PC24', 'SF50', 'EA50', 'TBM7', 'TBM8', 'TBM9', 'P180', 'BE20',
]);

/** Airline-style callsign: 3-letter ICAO designator followed by a flight number, e.g. RYR7UK. */
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d/;

export function classify(a: ClassifyInput): AircraftKind {
  const cs = a.callsign.toUpperCase();
  const airlineStyle = AIRLINE_CALLSIGN.test(cs);
  const cat = a.category;

  if (a.dbFlags & 1) return 'military';
  if (cat === 'A7') return 'helicopter';
  if (cat === 'B1' || cat === 'B2' || cat === 'B3' || cat === 'B4') return 'private'; // gliders, balloons, skydivers, ultralights
  if (cat.startsWith('B')) return 'other'; // UAVs, spacecraft

  if (airlineStyle && CARGO_PREFIXES.has(cs.slice(0, 3))) return 'cargo';

  const lightOrBiz = cat === 'A1' || BIZ_TYPES.has(a.type);
  if (lightOrBiz) return 'private';

  if (CARGO_OPERATOR.test(a.operator)) return 'cargo';
  if (FREIGHTER_TYPES.has(a.type)) {
    // a 777-200LR passenger flight from these airlines has a low flight number; their cargo flights use high ones
    const number = airlineStyle ? parseInt(cs.slice(3), 10) : NaN;
    if (!(PASSENGER_B77L_AIRLINES.has(cs.slice(0, 3)) && !(number >= 2000))) return 'cargo';
  }
  if (airlineStyle) return 'commercial';
  if (AIRLINER_TYPE.test(a.type) && !/^N\d/.test(cs)) return 'commercial'; // airliner with a missing or odd callsign
  if (cat === 'A2') return 'private'; // small aircraft without an airline callsign
  return 'other';
}
