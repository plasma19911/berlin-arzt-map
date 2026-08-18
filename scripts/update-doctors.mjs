import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'data', 'doctors.json');
const ADDITIONAL_INPUT = path.join(ROOT, 'data', 'additional-doctor-candidates.json');
const GEO_CACHE = path.join(ROOT, 'data', 'additional-geocache.json');
const ADDRESS = 'Marwitzer Str. 67, 13589 Berlin';
const RADIUS_METERS = 10000;
const MAX_DISTANCE_KM = 10.08;
const FALLBACK_HOME = { lat: 52.5738, lon: 13.1568, displayName: `${ADDRESS} (Fallback-Mittelpunkt)` };
const USER_AGENT = 'berlin-arzt-map/3.0 (+https://github.com/plasma19911/berlin-arzt-map)';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OVERPASS_URLS = [
  process.env.OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
].filter(Boolean);
const NOMINATIM_MIN_DELAY_MS = 1100;
const FAILED_GEOCODE_RETRY_MS = 30 * 86400000;
let lastNominatimRequestAt = 0;

const SPECIALTIES = new Map([
  ['general', 'Allgemeinmedizin'], ['general_practice', 'Allgemeinmedizin'], ['family_medicine', 'Allgemeinmedizin'],
  ['internal', 'Innere Medizin'], ['internal_medicine', 'Innere Medizin'], ['cardiology', 'Kardiologie'],
  ['dermatology', 'Dermatologie'], ['dermatovenereology', 'Dermatologie und Venerologie'],
  ['gynaecology', 'Gynäkologie'], ['gynecology', 'Gynäkologie'], ['obstetrics', 'Geburtshilfe'],
  ['ophthalmology', 'Augenheilkunde'], ['paediatrics', 'Kinder- und Jugendmedizin'], ['pediatrics', 'Kinder- und Jugendmedizin'],
  ['psychiatry', 'Psychiatrie'], ['psychotherapy', 'Psychotherapie'], ['urology', 'Urologie'],
  ['orthopaedics', 'Orthopädie'], ['orthopedics', 'Orthopädie'], ['radiology', 'Radiologie'],
  ['otolaryngology', 'Hals-Nasen-Ohren-Heilkunde'], ['ear_nose_throat', 'Hals-Nasen-Ohren-Heilkunde'], ['ent', 'Hals-Nasen-Ohren-Heilkunde'],
  ['neurology', 'Neurologie'], ['neurosurgery', 'Neurochirurgie'], ['surgery', 'Chirurgie'],
  ['trauma_surgery', 'Unfallchirurgie'], ['oncology', 'Onkologie'], ['nephrology', 'Nephrologie'],
  ['gastroenterology', 'Gastroenterologie'], ['endocrinology', 'Endokrinologie'], ['rheumatology', 'Rheumatologie'],
  ['pulmonology', 'Pneumologie'], ['pneumology', 'Pneumologie'], ['allergology', 'Allergologie'],
  ['anaesthetics', 'Anästhesiologie'], ['anesthesiology', 'Anästhesiologie'], ['anaesthesiology', 'Anästhesiologie'],
  ['dentistry', 'Zahnmedizin'], ['oral_surgery', 'Oralchirurgie'], ['orthodontics', 'Kieferorthopädie'],
]);

async function main() {
  const previous = await readJson(OUTPUT, null);
  const home = await resolveHome(previous?.home);

  const [elements, additional] = await Promise.all([
    fetchDoctors(home),
    loadAdditionalDoctors(home),
  ]);

  const osmDoctors = normalizeOsm(elements, home);
  const doctors = dedupe([...osmDoctors, ...additional])
    .filter((doctor) => Number(doctor.distanceKm) <= MAX_DISTANCE_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name, 'de'));

  const output = {
    schemaVersion: 3,
    source: 'OpenStreetMap/Overpass + kuratierte öffentliche Arzt- und Praxisverzeichnisse',
    sourceLicense: 'OSM: ODbL 1.0; ergänzende Kontaktdaten mit Quellenhinweis am Eintrag',
    sources: [
      { name: 'OpenStreetMap / Overpass', url: 'https://www.openstreetmap.org/' },
      { name: 'Stadt Falkensee – Ärzteverzeichnis', url: 'https://www.falkensee.de/verzeichnis/index.php?bereich=57' },
      { name: 'Öffentlich auffindbare Arzt-/Praxisverzeichnisse', url: null },
    ],
    address: ADDRESS,
    radiusMeters: RADIUS_METERS,
    home,
    updatedAt: new Date().toISOString(),
    stats: {
      osm: osmDoctors.length,
      additionalWithinRadius: additional.length,
      combined: doctors.length,
    },
    doctors,
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Gespeichert: ${doctors.length} Einträge (${osmDoctors.length} OSM, ${additional.length} Ergänzungen im Radius).`);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function resolveHome(previousHome) {
  if (Number.isFinite(Number(previousHome?.lat)) && Number.isFinite(Number(previousHome?.lon))) {
    return { lat: Number(previousHome.lat), lon: Number(previousHome.lon), displayName: previousHome.displayName || ADDRESS };
  }

  const queries = [ADDRESS, 'Marwitzer Straße, 13589 Berlin', 'Marwitzer Str., 13589 Berlin'];
  for (const query of queries) {
    try {
      const result = await nominatimSearch(query);
      if (result) return result;
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

function normalizeOsm(elements, home) {
  const uniqueOsm = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));
  const rows = [];
  for (const element of uniqueOsm.values()) {
    const tags = element.tags || {};
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distanceKm = haversineKm(home.lat, home.lon, lat, lon);
    if (distanceKm > MAX_DISTANCE_KM) continue;

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
      dataSource: 'OpenStreetMap',
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      sources: [{ name: 'OpenStreetMap', url: `https://www.openstreetmap.org/${element.type}/${element.id}` }],
    });
  }
  return dedupe(rows);
}

async function loadAdditionalDoctors(home) {
  const source = await readJson(ADDITIONAL_INPUT, { doctors: [] });
  const candidates = Array.isArray(source?.doctors) ? source.doctors : [];
  if (!candidates.length) return [];

  const cache = await readJson(GEO_CACHE, { schemaVersion: 1, items: {} });
  cache.schemaVersion = 1;
  cache.items = cache.items && typeof cache.items === 'object' ? cache.items : {};

  const uniqueAddresses = [...new Set(candidates.map((item) => String(item.address || '').trim()).filter(Boolean))];
  let cacheChanged = false;
  let liveGeocodes = 0;

  for (const address of uniqueAddresses) {
    const key = addressKey(address);
    const existing = cache.items[key];
    const hasCoords = Number.isFinite(Number(existing?.lat)) && Number.isFinite(Number(existing?.lon));
    const failureFresh = existing?.notFound && Date.now() - new Date(existing.checkedAt || 0).getTime() < FAILED_GEOCODE_RETRY_MS;
    if (hasCoords || failureFresh) continue;

    try {
      const geocoded = await nominatimSearch(address);
      liveGeocodes += 1;
      if (geocoded) {
        cache.items[key] = {
          address,
          lat: round(geocoded.lat, 7),
          lon: round(geocoded.lon, 7),
          displayName: geocoded.displayName || address,
          checkedAt: new Date().toISOString(),
        };
      } else {
        cache.items[key] = { address, notFound: true, checkedAt: new Date().toISOString() };
      }
      cacheChanged = true;
    } catch (error) {
      console.warn(`Zusatzadresse nicht geokodiert: ${address}: ${error.message}`);
    }
  }

  if (cacheChanged) {
    cache.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(GEO_CACHE), { recursive: true });
    await fs.writeFile(GEO_CACHE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  }
  console.log(`Zusatzquellen: ${candidates.length} Kandidaten, ${uniqueAddresses.length} eindeutige Adressen, ${liveGeocodes} neue Geokodierungen.`);

  const rows = [];
  for (const candidate of candidates) {
    const address = String(candidate.address || '').trim();
    const cached = address ? cache.items[addressKey(address)] : null;
    const lat = Number(candidate.lat ?? cached?.lat);
    const lon = Number(candidate.lon ?? cached?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distanceKm = haversineKm(home.lat, home.lon, lat, lon);
    if (distanceKm > MAX_DISTANCE_KM) continue;

    const sourceName = String(candidate.sourceName || 'Ergänzende öffentliche Quelle');
    const sourceUrl = safeHttpUrl(candidate.sourceUrl);
    rows.push({
      id: `web-${stableHash(`${candidate.name || ''}|${address}`)}`,
      name: String(candidate.name || 'Unbenannte Arztpraxis').trim(),
      type: String(candidate.type || 'Arztpraxis').trim(),
      specialties: [...new Set((Array.isArray(candidate.specialties) ? candidate.specialties : []).map((v) => String(v).trim()).filter(Boolean))],
      lat: round(lat, 7), lon: round(lon, 7), distanceKm: round(distanceKm, 3),
      address: address || null,
      openingHours: candidate.openingHours || null,
      phone: candidate.phone || null,
      website: safeHttpUrl(candidate.website),
      email: candidate.email || null,
      wheelchair: candidate.wheelchair || null,
      rating: null,
      ratingCount: null,
      dataSource: sourceName,
      sourceUrl,
      sources: [{ name: sourceName, url: sourceUrl }],
    });
  }

  return dedupe(rows);
}

async function nominatimSearch(query) {
  await respectNominatimRateLimit();
  const url = new URL('/search', NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'de');
  const result = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'de' } }, 30000);
  if (!Array.isArray(result) || !result[0]) return null;
  const lat = Number(result[0].lat);
  const lon = Number(result[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, displayName: result[0].display_name || query };
}

async function respectNominatimRateLimit() {
  const elapsed = Date.now() - lastNominatimRequestAt;
  const wait = NOMINATIM_MIN_DELAY_MS - elapsed;
  if (wait > 0) await sleep(wait);
  lastNominatimRequestAt = Date.now();
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
    const named = item?.name && !String(item.name).startsWith('Unbenannte ');
    const key = named && item.address
      ? `${canonicalName(item.name)}|${addressKey(item.address)}`
      : `${item.type}|${round(item.lat, 4)}|${round(item.lon, 4)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...item, specialties: [...new Set(item.specialties || [])], sources: normalizeSources(item.sources, item) });
      continue;
    }

    const preferred = completeness(item) > completeness(existing) ? { ...item } : { ...existing };
    const other = preferred.id === item.id ? existing : item;
    preferred.specialties = [...new Set([...(preferred.specialties || []), ...(other.specialties || [])])];
    preferred.sources = mergeSources(normalizeSources(existing.sources, existing), normalizeSources(item.sources, item));
    for (const field of ['address', 'openingHours', 'phone', 'website', 'email', 'wheelchair', 'sourceUrl', 'dataSource']) {
      if (!preferred[field] && other[field]) preferred[field] = other[field];
    }
    map.set(key, preferred);
  }
  return [...map.values()];
}

function normalizeSources(sources, item) {
  if (Array.isArray(sources) && sources.length) {
    return sources.map((s) => ({ name: s?.name || 'Quelle', url: safeHttpUrl(s?.url) })).filter((s) => s.name);
  }
  if (item?.dataSource || item?.sourceUrl) return [{ name: item.dataSource || 'Quelle', url: safeHttpUrl(item.sourceUrl) }];
  return [];
}

function mergeSources(a, b) {
  const seen = new Set();
  const result = [];
  for (const source of [...a, ...b]) {
    const key = `${source.name}|${source.url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

function completeness(item) {
  return ['address','openingHours','phone','website','email','wheelchair'].reduce((n, k) => n + (item?.[k] ? 1 : 0), 0);
}

function canonicalName(value) {
  return keyText(value)
    .replace(/\b(dr|med|prof|dipl|stom|phil|facharzt|facharztin|praxis|arztpraxis)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressKey(value) {
  return keyText(value)
    .replace(/\bstrasse\b|\bstr\b/g, 'str')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyText(value) {
  return String(value || '').toLocaleLowerCase('de').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).startsWith('http') ? value : `https://${value}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function haversineKm(a,b,c,d) {
  const R=6371.0088, x=rad(c-a), y=rad(d-b);
  const q=Math.sin(x/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(y/2)**2;
  return R*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));
}
function rad(v) { return v * Math.PI / 180; }
function round(v,d) { const f=10**d; return Math.round(v*f)/f; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
