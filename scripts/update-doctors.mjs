import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'data', 'doctors.json');
const ADDRESS = 'Marwitzer Str. 67, 13589 Berlin';
const RADIUS_METERS = 10000;
const FALLBACK_HOME = { lat: 52.5738, lon: 13.1568, displayName: `${ADDRESS} (Fallback-Mittelpunkt)` };
const USER_AGENT = 'berlin-arzt-map/2.0 (+https://github.com/plasma19911/berlin-arzt-map)';
const OVERPASS_URLS = [
  process.env.OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
].filter(Boolean);

const SPECIALTIES = new Map([
  ['general', 'Allgemeinmedizin'], ['general_practice', 'Allgemeinmedizin'], ['family_medicine', 'Allgemeinmedizin'],
  ['internal', 'Innere Medizin'], ['internal_medicine', 'Innere Medizin'], ['cardiology', 'Kardiologie'],
  ['dermatology', 'Dermatologie'], ['gynaecology', 'Gynäkologie'], ['gynecology', 'Gynäkologie'],
  ['ophthalmology', 'Augenheilkunde'], ['paediatrics', 'Kinder- und Jugendmedizin'], ['pediatrics', 'Kinder- und Jugendmedizin'],
  ['psychiatry', 'Psychiatrie'], ['psychotherapy', 'Psychotherapie'], ['urology', 'Urologie'],
  ['orthopaedics', 'Orthopädie'], ['orthopedics', 'Orthopädie'], ['radiology', 'Radiologie'],
  ['otolaryngology', 'HNO'], ['ear_nose_throat', 'HNO'], ['neurology', 'Neurologie'],
  ['surgery', 'Chirurgie'], ['oncology', 'Onkologie'], ['nephrology', 'Nephrologie'],
  ['gastroenterology', 'Gastroenterologie'], ['endocrinology', 'Endokrinologie'], ['rheumatology', 'Rheumatologie'],
  ['pulmonology', 'Pneumologie'], ['allergology', 'Allergologie'], ['anaesthetics', 'Anästhesiologie'],
  ['dentistry', 'Zahnmedizin'], ['oral_surgery', 'Oralchirurgie'], ['orthodontics', 'Kieferorthopädie'],
]);

async function main() {
  const previous = await readPrevious();
  const home = await resolveHome(previous?.home);
  const elements = await fetchDoctors(home);
  const doctors = normalize(elements, home);
  const output = {
    schemaVersion: 2,
    source: 'OpenStreetMap via Overpass API',
    sourceLicense: 'ODbL 1.0',
    address: ADDRESS,
    radiusMeters: RADIUS_METERS,
    home,
    updatedAt: new Date().toISOString(),
    doctors,
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Gespeichert: ${doctors.length} Einträge.`);
}

async function readPrevious() {
  try { return JSON.parse(await fs.readFile(OUTPUT, 'utf8')); } catch { return null; }
}

async function resolveHome(previousHome) {
  if (Number.isFinite(Number(previousHome?.lat)) && Number.isFinite(Number(previousHome?.lon))) {
    return { lat: Number(previousHome.lat), lon: Number(previousHome.lon), displayName: previousHome.displayName || ADDRESS };
  }

  const nominatim = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  const queries = [ADDRESS, 'Marwitzer Straße, 13589 Berlin', 'Marwitzer Str., 13589 Berlin'];
  for (const query of queries) {
    try {
      const url = new URL('/search', nominatim);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '1');
      url.searchParams.set('countrycodes', 'de');
      const result = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'de' } }, 30000);
      if (Array.isArray(result) && result[0]) {
        return { lat: Number(result[0].lat), lon: Number(result[0].lon), displayName: result[0].display_name || query };
      }
    } catch (error) {
      console.warn(`Geokodierung fehlgeschlagen für "${query}": ${error.message}`);
    }
  }
  console.warn('Nominatim lieferte keinen Treffer; verwende den festen Mittelpunkt nahe der Startadresse.');
  return FALLBACK_HOME;
}

async function fetchDoctors(home) {
  const selectors = [
    '["amenity"="doctors"]', '["healthcare"="doctor"]', '["amenity"="dentist"]', '["healthcare"="dentist"]',
    '["amenity"="clinic"]', '["healthcare"="clinic"]', '["healthcare"="medical_centre"]',
    '["amenity"="hospital"]', '["healthcare"="hospital"]', '["healthcare"="psychotherapist"]',
  ];
  const blocks = selectors.map((s) => `nwr(around:${RADIUS_METERS},${home.lat},${home.lon})${s};`).join('\n');
  const query = `[out:json][timeout:120];\n(\n${blocks}\n);\nout center tags;`;
  let lastError;

  for (const endpoint of OVERPASS_URLS) {
    try {
      console.log(`Overpass: ${endpoint}`);
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ data: query }),
      }, 150000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json.elements)) throw new Error('Ungültige Overpass-Antwort');
      return json.elements;
    } catch (error) {
      lastError = error;
      console.warn(`Overpass-Endpunkt fehlgeschlagen: ${error.message}`);
    }
  }
  throw lastError || new Error('Kein Overpass-Endpunkt erreichbar.');
}

function normalize(elements, home) {
  const uniqueOsm = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));
  const rows = [];
  for (const element of uniqueOsm.values()) {
    const tags = element.tags || {};
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distanceKm = haversineKm(home.lat, home.lon, lat, lon);
    if (distanceKm > 10.08) continue;

    const type = inferType(tags);
    const specialties = inferSpecialties(tags, type);
    const name = tags.name || tags.operator || fallbackName(type, specialties);
    rows.push({
      id: `${element.type}-${element.id}`,
      osmType: element.type,
      osmId: element.id,
      name,
      type,
      specialties,
      lat: round(lat, 7), lon: round(lon, 7), distanceKm: round(distanceKm, 3),
      address: buildAddress(tags),
      openingHours: tags.opening_hours || null,
      phone: tags['contact:phone'] || tags.phone || null,
      website: tags['contact:website'] || tags.website || null,
      email: tags['contact:email'] || tags.email || null,
      wheelchair: tags.wheelchair || null,
      rating: parseRating(tags.rating ?? tags.stars ?? tags['review:rating']),
      ratingCount: parseIntSafe(tags['review:count'] ?? tags.rating_count),
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    });
  }
  return dedupe(rows).sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name, 'de'));
}

function inferType(tags) {
  if (tags.amenity === 'dentist' || tags.healthcare === 'dentist') return 'Zahnarztpraxis';
  if (tags.healthcare === 'psychotherapist') return 'Psychotherapeutische Praxis';
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return 'Krankenhaus';
  if (tags.healthcare === 'medical_centre') return 'Medizinisches Versorgungszentrum';
  if (tags.amenity === 'clinic' || tags.healthcare === 'clinic') return 'Klinik / MVZ';
  return 'Arztpraxis';
}

function inferSpecialties(tags, type) {
  const raw = [tags['healthcare:speciality'], tags.speciality, tags.specialty].filter(Boolean).join(';')
    .split(/[;,|]/).map((v) => v.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
  const values = [...new Set(raw.map((v) => SPECIALTIES.get(v) || humanize(v)))];
  if (!values.length && type === 'Zahnarztpraxis') values.push('Zahnmedizin');
  if (!values.length && type === 'Psychotherapeutische Praxis') values.push('Psychotherapie');
  return values;
}

function buildAddress(tags) {
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = [tags['addr:postcode'], tags['addr:city'] || tags['addr:suburb']].filter(Boolean).join(' ');
  return [street, city].filter(Boolean).join(', ') || null;
}
function fallbackName(type, specialties) { return specialties.length ? `${type} · ${specialties[0]}` : `Unbenannte ${type}`; }
function humanize(value) { return value.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()); }
function parseRating(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 5 ? round(n, 1) : null;
}
function parseIntSafe(value) { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n >= 0 ? n : null; }

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const named = !item.name.startsWith('Unbenannte ');
    const key = named && item.address
      ? `${keyText(item.name)}|${keyText(item.address)}`
      : `${item.type}|${round(item.lat, 4)}|${round(item.lon, 4)}`;
    const existing = map.get(key);
    if (!existing) { map.set(key, item); continue; }
    const winner = completeness(item) > completeness(existing) ? item : existing;
    const loser = winner === item ? existing : item;
    winner.specialties = [...new Set([...(winner.specialties || []), ...(loser.specialties || [])])];
    map.set(key, winner);
  }
  return [...map.values()];
}
function completeness(item) { return ['address','openingHours','phone','website','email','wheelchair','rating'].reduce((n, k) => n + (item[k] ? 1 : 0), 0); }
function keyText(value) { return String(value || '').toLocaleLowerCase('de').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, ' ').trim(); }
function haversineKm(a,b,c,d) { const R=6371.0088, x=rad(c-a), y=rad(d-b); const q=Math.sin(x/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(y/2)**2; return R*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q)); }
function rad(v) { return v * Math.PI / 180; }
function round(v,d) { const f=10**d; return Math.round(v*f)/f; }

async function fetchJson(url, options, timeout) {
  const response = await fetchWithTimeout(url, options, timeout);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
