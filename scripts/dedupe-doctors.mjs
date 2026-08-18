import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'doctors.json');
const MAX_DUPLICATE_DISTANCE_KM = 0.18;

const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
const doctors = Array.isArray(data.doctors) ? data.doctors : [];
const groups = new Map();

for (const doctor of doctors) {
  const name = canonicalName(doctor.name);
  if (!name || name.startsWith('unbenannte ')) {
    addUnique(doctor);
    continue;
  }

  const candidates = groups.get(name) || [];
  const duplicateIndex = candidates.findIndex((existing) => sameDoctorLocation(existing, doctor));
  if (duplicateIndex === -1) {
    candidates.push(cloneDoctor(doctor));
    groups.set(name, candidates);
  } else {
    candidates[duplicateIndex] = mergeDoctor(candidates[duplicateIndex], doctor);
  }
}

const deduped = [];
for (const entries of groups.values()) deduped.push(...entries);
for (const doctor of ungrouped) deduped.push(doctor);

deduped.sort((a, b) => Number(a.distanceKm ?? Infinity) - Number(b.distanceKm ?? Infinity) || String(a.name || '').localeCompare(String(b.name || ''), 'de'));

const removed = doctors.length - deduped.length;
data.doctors = deduped;
data.stats = {
  ...(data.stats || {}),
  combined: deduped.length,
  duplicatesRemoved: removed,
};

await fs.writeFile(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log(`Dublettenbereinigung: ${doctors.length} -> ${deduped.length} (${removed} entfernt).`);

const ungrouped = [];

function addUnique(doctor) {
  ungrouped.push(cloneDoctor(doctor));
}

function sameDoctorLocation(a, b) {
  const latA = Number(a.lat);
  const lonA = Number(a.lon);
  const latB = Number(b.lat);
  const lonB = Number(b.lon);
  if ([latA, lonA, latB, lonB].every(Number.isFinite)) {
    return haversineKm(latA, lonA, latB, lonB) <= MAX_DUPLICATE_DISTANCE_KM;
  }
  const addrA = canonicalAddress(a.address);
  const addrB = canonicalAddress(b.address);
  return Boolean(addrA && addrB && addrA === addrB);
}

function mergeDoctor(a, b) {
  const preferred = completeness(b) > completeness(a) ? cloneDoctor(b) : cloneDoctor(a);
  const other = preferred.id === b.id ? a : b;

  preferred.specialties = unique([...(preferred.specialties || []), ...(other.specialties || [])]);
  preferred.sources = mergeSources(a.sources, b.sources, a, b);

  for (const field of ['address', 'openingHours', 'phone', 'website', 'email', 'wheelchair', 'sourceUrl', 'dataSource']) {
    if (!preferred[field] && other[field]) preferred[field] = other[field];
  }

  if ((preferred.rating == null || Number(preferred.rating) <= 0) && Number(other.rating) > 0) preferred.rating = other.rating;
  if (!preferred.ratingCount && other.ratingCount) preferred.ratingCount = other.ratingCount;

  return preferred;
}

function cloneDoctor(doctor) {
  return {
    ...doctor,
    specialties: unique(doctor.specialties || []),
    sources: normalizeSources(doctor.sources, doctor),
  };
}

function completeness(item) {
  return ['address', 'openingHours', 'phone', 'website', 'email', 'wheelchair', 'rating'].reduce((score, key) => score + (item?.[key] ? 1 : 0), 0);
}

function mergeSources(a, b, itemA, itemB) {
  const all = [...normalizeSources(a, itemA), ...normalizeSources(b, itemB)];
  const seen = new Set();
  return all.filter((source) => {
    const key = `${source.name || ''}|${source.url || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSources(sources, item) {
  if (Array.isArray(sources) && sources.length) {
    return sources.map((source) => ({ name: source?.name || 'Quelle', url: source?.url || null }));
  }
  if (item?.dataSource || item?.sourceUrl) return [{ name: item.dataSource || 'Quelle', url: item.sourceUrl || null }];
  return [];
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function canonicalName(value) {
  return normalize(value)
    .replace(/\b(priv dozent|priv doz|pd|professor|prof|doktor|dr|med|dent|dipl|stom|facharzt|facharztin)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalAddress(value) {
  return normalize(value)
    .replace(/\b(strasse|str)\b/g, 'str')
    .replace(/\b(platz)\b/g, 'platz')
    .replace(/\s+(\d+)\s+([a-z])\b/g, ' $1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value) {
  return String(value || '')
    .toLocaleLowerCase('de')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
