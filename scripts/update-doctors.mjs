import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'doctors.json');

const CONFIG = {
  address: 'Marwitzer Str. 67, 13589 Berlin',
  radiusMeters: 10000,
  nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  overpassUrl: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
  userAgent: 'berlin-arzt-map/1.0 (+https://github.com/plasma19911/berlin-arzt-map)',
};

const SPECIALTY_LABELS = new Map([
  ['general', 'Allgemeinmedizin'],
  ['general_practice', 'Allgemeinmedizin'],
  ['family_medicine', 'Allgemeinmedizin'],
  ['internal', 'Innere Medizin'],
  ['internal_medicine', 'Innere Medizin'],
  ['cardiology', 'Kardiologie'],
  ['dermatology', 'Dermatologie'],
  ['gynaecology', 'Gynäkologie'],
  ['gynecology', 'Gynäkologie'],
  ['obstetrics', 'Geburtshilfe'],
  ['ophthalmology', 'Augenheilkunde'],
  ['paediatrics', 'Kinder- und Jugendmedizin'],
  ['pediatrics', 'Kinder- und Jugendmedizin'],
  ['psychiatry', 'Psychiatrie'],
  ['psychotherapy', 'Psychotherapie'],
  ['urology', 'Urologie'],
  ['orthopaedics', 'Orthopädie'],
  ['orthopedics', 'Orthopädie'],
  ['radiology', 'Radiologie'],
  ['otolaryngology', 'HNO'],
  ['ear_nose_throat', 'HNO'],
  ['neurology', 'Neurologie'],
  ['surgery', 'Chirurgie'],
  ['vascular_surgery', 'Gefäßchirurgie'],
  ['plastic_surgery', 'Plastische Chirurgie'],
  ['oncology', 'Onkologie'],
  ['nephrology', 'Nephrologie'],
  ['gastroenterology', 'Gastroenterologie'],
  ['endocrinology', 'Endokrinologie'],
  ['rheumatology', 'Rheumatologie'],
  ['pulmonology', 'Pneumologie'],
  ['allergology', 'Allergologie'],
  ['anaesthetics', 'Anästhesiologie'],
  ['dentistry', 'Zahnmedizin'],
  ['oral_surgery', 'Oralchirurgie'],
  ['orthodontics', 'Kieferorthopädie'],
]);

async function main() {
  const previous = await readPrevious();
  const home = await resolveHome(previous?.home);
  const elements = await fetchDoctors(home.lat, home.lon);
  const doctors = normalizeElements(elements, home);

  const output = {
    schemaVersion: 1,
    source: 'OpenStreetMap via Overpass API',
    sourceLicense: 'ODbL 1.0',
    address: CONFIG.address,
    radiusMeters: CONFIG.radiusMeters,
    home,
    updatedAt: new Date().toISOString(),
    doctors,
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Gespeichert: ${doctors.length} Einträge in ${path.relative(ROOT, OUTPUT)}`);
}

async function readPrevious() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
  } catch {
    return null;
  }
}

async function resolveHome(previousHome) {
  const lat = Number(previousHome?.lat);
  const lon = Number(previousHome?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    console.log('Verwende zwischengespeicherte Startkoordinaten.');
    return { lat, lon, displayName: previousHome.displayName || CONFIG.address };
  }

  console.log('Geokodiere Startadresse einmalig über Nominatim …');
  const url = new URL('/search', CONFIG.nominatimUrl);
  url.searchParams.set('q', CONFIG.address);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'de');

  const data = await fetchJson(url, {
    headers: {
      'User-Agent': CONFIG.userAgent,
      'Accept-Language': 'de',
    },
  });

  if (!Array.isArray(data) || !data[0]) throw new Error(`Startadresse nicht gefunden: ${CONFIG.address}`);
  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
    displayName: data[0].display_name || CONFIG.address,
  };
}

async function fetchDoctors(lat, lon) {
  const r = CONFIG.radiusMeters;
  const selectors = [
    '["amenity"="doctors"]',
    '["healthcare"="doctor"]',
    '["amenity"="dentist"]',
    '["healthcare"="dentist"]',
    '["amenity"="clinic"]',
    '["healthcare"="clinic"]',
    '["healthcare"="medical_centre"]',
  ];
  const blocks = selectors.map((selector) => `nwr(around:${r},${lat},${lon})${selector};`).join('\n');
  const query = `[out:json][timeout:120];\n(\n${blocks}\n);\nout center tags;`;

  console.log('Lade Arzt-/Praxisdaten über Overpass …');
  const response = await fetchWithTimeout(CONFIG.overpassUrl, {
    method: 'POST',
    headers: {
      'User-Agent': CONFIG.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: new URLSearchParams({ data: query }),
  }, 150000);

  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}: ${await response.text()}`);
  const json = await response.json();
  if (!Array.isArray(json.elements)) throw new Error('Overpass-Antwort enthält keine Elemente.');
  return json.elements;
}

function normalizeElements(elements, home) {
  const byOsmId = new Map();
  for (const element of elements) byOsmId.set(`${element.type}/${element.id}`, element);

  const normalized = [];
  for (const element of byOsmId.values()) {
    const tags = element.tags || {};
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const distanceKm = haversineKm(home.lat, home.lon, lat, lon);
    if (distanceKm > CONFIG.radiusMeters / 1000 + 0.08) continue;

    const type = inferType(tags);
    const specialties = inferSpecialties(tags, type);
    const name = tags.name || tags.operator || fallbackName(type, specialties);
    const address = buildAddress(tags);
    const rating = parseRating(tags.rating ?? tags.stars ?? tags['review:rating']);
    const ratingCount = parsePositiveInteger(tags['review:count'] ?? tags.rating_count);

    normalized.push({
      id: `${element.type}-${element.id}`,
      osmType: element.type,
      osmId: element.id,
      name,
      type,
      specialties,
      lat: round(lat, 7),
      lon: round(lon, 7),
      distanceKm: round(distanceKm, 3),
      address,
      openingHours: tags.opening_hours || null,
      phone: tags['contact:phone'] || tags.phone || null,
      website: tags['contact:website'] || tags.website || null,
      email: tags['contact:email'] || tags.email || null,
      wheelchair: tags.wheelchair || null,
      rating,
      ratingCount,
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    });
  }

  const deduped = dedupe(normalized);
  return deduped.sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name, 'de'));
}

function inferType(tags) {
  if (tags.amenity === 'dentist' || tags.healthcare === 'dentist') return 'Zahnarztpraxis';
  if (tags.healthcare === 'medical_centre') return 'Medizinisches Versorgungszentrum';
  if (tags.amenity === 'clinic' || tags.healthcare === 'clinic') return 'Klinik / MVZ';
  return 'Arztpraxis';
}

function inferSpecialties(tags, type) {
  const raw = [tags['healthcare:speciality'], tags.speciality, tags.specialty]
    .filter(Boolean)
    .join(';')
    .split(/[;,|]/)
    .map((item) => item.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean);

  const labels = [];
  for (const item of raw) {
    const label = SPECIALTY_LABELS.get(item) || humanize(item);
    if (!labels.includes(label)) labels.push(label);
  }
  if (!labels.length && type === 'Zahnarztpraxis') labels.push('Zahnmedizin');
  return labels;
}

function buildAddress(tags) {
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = [tags['addr:postcode'], tags['addr:city'] || tags['addr:suburb']].filter(Boolean).join(' ');
  return [street, city].filter(Boolean).join(', ') || null;
}

function fallbackName(type, specialties) {
  if (specialties.length) return `${type} · ${specialties[0]}`;
  return `Unbenannte ${type}`;
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${normalizeKey(item.name)}|${normalizeKey(item.address || '')}`;
    if (!map.has(key)) {
      map.set(key, item);
      continue;
    }
    const existing = map.get(key);
    const winner = completeness(item) > completeness(existing) ? item : existing;
    const loser = winner === item ? existing : item;
    winner.specialties = [...new Set([...(winner.specialties || []), ...(loser.specialties || [])])];
    map.set(key, winner);
  }
  return [...map.values()];
}

function completeness(item) {
  return ['address', 'openingHours', 'phone', 'website', 'email', 'wheelchair', 'rating']
    .reduce((score, key) => score + (item[key] ? 1 : 0), 0);
}

function normalizeKey(value) {
  return String(value || '').toLocaleLowerCase('de').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, ' ').trim();
}

function humanize(value) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseRating(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? round(parsed, 1) : null;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(value) { return value * Math.PI / 180; }
function round(value, digits) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options, 30000);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
