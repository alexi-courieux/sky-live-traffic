// Builds src/data/airports.json from the OurAirports dataset (public domain).
// Usage: node scripts/build-airports.mjs
// Keeps large/medium airports that have an ICAO code, as compact tuples:
// [icao, iata, name, lat, lon, elevationFt, isLarge(0|1), country, municipality]
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  return rows;
}

const res = await fetch(URL);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const [header, ...rows] = parseCsv(await res.text());
const col = Object.fromEntries(header.map((h, i) => [h, i]));

const airports = rows
  .filter((r) => (r[col.type] === 'large_airport' || r[col.type] === 'medium_airport') && r[col.icao_code])
  .map((r) => [
    r[col.icao_code],
    r[col.iata_code] || '',
    r[col.name],
    Math.round(parseFloat(r[col.latitude_deg]) * 1e4) / 1e4,
    Math.round(parseFloat(r[col.longitude_deg]) * 1e4) / 1e4,
    Math.round(parseFloat(r[col.elevation_ft]) || 0),
    r[col.type] === 'large_airport' ? 1 : 0,
    r[col.iso_country],
    r[col.municipality],
  ]);

mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/airports.json', JSON.stringify(airports));
console.log(`Wrote ${airports.length} airports`);
