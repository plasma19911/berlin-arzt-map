(() => {
  'use strict';

  const STORAGE_KEY = 'berlin-arzt-map-google-key';
  const RADIUS_METERS = 10000;
  const GRID_OFFSET_KM = 6;
  const CELL_RADIUS_METERS = 4500;
  const SEARCH_GROUPS = [
    ['doctor'],
    ['dentist', 'dental_clinic'],
    ['medical_clinic', 'medical_center', 'hospital', 'general_hospital'],
  ];

  let apiPromise = null;
  let placesLibraryPromise = null;
  let lastHome = null;
  let loading = false;

  const bridge = {
    isConfigured,
    getKey,
    setKey,
    clearKey,
    loadForHome,
    fetchDetails,
  };
  window.GooglePlacesBridge = bridge;

  bindButton();
  window.addEventListener('berlinarzt:osmready', (event) => {
    lastHome = event.detail?.home || null;
    if (isConfigured() && lastHome) void loadForHome(lastHome);
    updateButton();
  });

  function bindButton() {
    const button = document.getElementById('googleButton');
    if (!button) return;
    button.addEventListener('click', () => {
      if (isConfigured()) {
        const replace = window.confirm('Google Maps ist aktiviert. Möchtest du den API-Schlüssel ändern?');
        if (!replace) return;
      }
      const key = window.prompt('Google Maps Browser-API-Key eingeben. Der Schlüssel wird nur auf diesem Gerät gespeichert:');
      if (key && key.trim()) setKey(key.trim());
    });
    updateButton();
  }

  function getKey() {
    return String(window.BERLIN_ARZT_MAP_GOOGLE_KEY || localStorage.getItem(STORAGE_KEY) || '').trim();
  }

  function isConfigured() {
    return Boolean(getKey());
  }

  function setKey(key) {
    localStorage.setItem(STORAGE_KEY, String(key || '').trim());
    apiPromise = null;
    placesLibraryPromise = null;
    updateButton('Google wird geladen …');
    if (lastHome) void loadForHome(lastHome, true);
  }

  function clearKey() {
    localStorage.removeItem(STORAGE_KEY);
    apiPromise = null;
    placesLibraryPromise = null;
    updateButton();
  }

  function updateButton(text = '') {
    const button = document.getElementById('googleButton');
    if (!button) return;
    if (text) {
      button.textContent = text;
      return;
    }
    button.textContent = isConfigured() ? 'G Google aktiv' : 'G Google Maps';
    button.classList.toggle('google-active', isConfigured());
  }

  async function loadGoogleApi() {
    if (window.google?.maps?.importLibrary) return window.google.maps;
    if (apiPromise) return apiPromise;
    const key = getKey();
    if (!key) throw new Error('Kein Google Maps API-Schlüssel hinterlegt.');

    apiPromise = new Promise((resolve, reject) => {
      const old = document.getElementById('google-maps-api-loader');
      if (old) old.remove();
      const callbackName = `__berlinArztGoogleReady_${Date.now()}`;
      const timeout = window.setTimeout(() => {
        delete window[callbackName];
        reject(new Error('Google Maps konnte nicht geladen werden.'));
      }, 20000);

      window[callbackName] = () => {
        window.clearTimeout(timeout);
        delete window[callbackName];
        resolve(window.google.maps);
      };

      const script = document.createElement('script');
      script.id = 'google-maps-api-loader';
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        window.clearTimeout(timeout);
        delete window[callbackName];
        reject(new Error('Google Maps Script konnte nicht geladen werden.'));
      };
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=places&language=de&region=DE&callback=${callbackName}`;
      document.head.appendChild(script);
    });
    return apiPromise;
  }

  async function getPlacesLibrary() {
    if (!placesLibraryPromise) {
      placesLibraryPromise = loadGoogleApi().then(() => google.maps.importLibrary('places'));
    }
    return placesLibraryPromise;
  }

  async function loadForHome(home, force = false) {
    if (!isConfigured() || loading || !home) return;
    const cacheKey = `berlin-arzt-map-google-session-${Number(home.lat).toFixed(4)}-${Number(home.lon).toFixed(4)}`;
    if (!force) {
      try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed?.doctors)) {
            dispatchDoctors(parsed.doctors, true);
            updateButton(`G Google ${parsed.doctors.length}`);
            return;
          }
        }
      } catch {}
    }

    loading = true;
    updateButton('G Google lädt …');
    dispatchStatus('Google Maps durchsucht den 10-km-Umkreis …', 'loading');
    try {
      const { Place, SearchNearbyRankPreference } = await getPlacesLibrary();
      const tasks = [];
      for (const center of gridCenters(home)) {
        for (const types of SEARCH_GROUPS) tasks.push({ center, types });
      }

      const unique = new Map();
      let cursor = 0;
      const workers = Array.from({ length: 3 }, async () => {
        while (cursor < tasks.length) {
          const task = tasks[cursor++];
          try {
            const { places } = await Place.searchNearby({
              fields: ['id', 'displayName', 'location', 'formattedAddress', 'primaryType', 'googleMapsURI'],
              locationRestriction: { center: task.center, radius: CELL_RADIUS_METERS },
              includedPrimaryTypes: task.types,
              maxResultCount: 20,
              rankPreference: SearchNearbyRankPreference.DISTANCE,
              language: 'de',
              region: 'DE',
            });
            for (const place of places || []) {
              if (place?.id) unique.set(place.id, place);
            }
          } catch (error) {
            console.warn('Google Nearby Search:', error);
          }
        }
      });
      await Promise.all(workers);

      const doctors = [...unique.values()]
        .map((place) => normalizePlace(place, home))
        .filter((doctor) => doctor && doctor.distanceKm <= 10.05)
        .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name, 'de'));

      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ doctors }));
      } catch {}
      dispatchDoctors(doctors, false);
      dispatchStatus(`${doctors.length} zusätzliche Google-Maps-Treffer geladen.`, 'ok');
      updateButton(`G Google ${doctors.length}`);
    } catch (error) {
      console.error(error);
      dispatchStatus(`Google Maps konnte nicht geladen werden: ${friendlyError(error)}`, 'error');
      updateButton('G Google Fehler');
    } finally {
      loading = false;
    }
  }

  function gridCenters(home) {
    const centers = [];
    const lat0 = Number(home.lat);
    const lon0 = Number(home.lon);
    const latKm = 111.32;
    const lonKm = 111.32 * Math.cos(lat0 * Math.PI / 180);
    for (const northKm of [-GRID_OFFSET_KM, 0, GRID_OFFSET_KM]) {
      for (const eastKm of [-GRID_OFFSET_KM, 0, GRID_OFFSET_KM]) {
        centers.push({
          lat: lat0 + northKm / latKm,
          lng: lon0 + eastKm / lonKm,
        });
      }
    }
    return centers;
  }

  function normalizePlace(place, home) {
    const lat = readLat(place.location);
    const lon = readLng(place.location);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const type = germanType(place.primaryType);
    return {
      id: `google-${place.id}`,
      googlePlaceId: place.id,
      source: 'google',
      googleSource: true,
      name: String(place.displayName || 'Arzt / Praxis'),
      type,
      specialties: type === 'Zahnarztpraxis' ? ['Zahnmedizin'] : [],
      lat,
      lon,
      distanceKm: haversineKm(Number(home.lat), Number(home.lon), lat, lon),
      address: place.formattedAddress || null,
      openingHours: null,
      phone: null,
      website: null,
      wheelchair: null,
      rating: null,
      ratingCount: null,
      googleMapsUri: place.googleMapsURI || null,
    };
  }

  async function fetchDetails(placeId) {
    if (!placeId || !isConfigured()) return null;
    const { Place } = await getPlacesLibrary();
    const place = new Place({ id: placeId, requestedLanguage: 'de' });
    await place.fetchFields({
      fields: [
        'displayName',
        'formattedAddress',
        'nationalPhoneNumber',
        'internationalPhoneNumber',
        'regularOpeningHours',
        'rating',
        'userRatingCount',
        'websiteURI',
        'googleMapsURI',
        'businessStatus',
        'accessibilityOptions',
        'attributions',
      ],
    });
    return {
      name: place.displayName || null,
      address: place.formattedAddress || null,
      phone: place.nationalPhoneNumber || place.internationalPhoneNumber || null,
      openingHours: place.regularOpeningHours?.weekdayDescriptions?.join(' · ') || null,
      rating: Number.isFinite(Number(place.rating)) ? Number(place.rating) : null,
      ratingCount: Number.isFinite(Number(place.userRatingCount)) ? Number(place.userRatingCount) : null,
      website: place.websiteURI || null,
      googleMapsUri: place.googleMapsURI || null,
      businessStatus: place.businessStatus || null,
      wheelchair: place.accessibilityOptions?.wheelchairAccessibleEntrance === true ? 'yes' : null,
      googleAttributions: Array.isArray(place.attributions) ? place.attributions : [],
    };
  }

  function dispatchDoctors(doctors, cached) {
    window.dispatchEvent(new CustomEvent('berlinarzt:googledata', { detail: { doctors, cached } }));
  }

  function dispatchStatus(message, mode) {
    window.dispatchEvent(new CustomEvent('berlinarzt:googlestatus', { detail: { message, mode } }));
  }

  function germanType(primaryType) {
    if (primaryType === 'dentist' || primaryType === 'dental_clinic') return 'Zahnarztpraxis';
    if (primaryType === 'hospital' || primaryType === 'general_hospital') return 'Krankenhaus';
    if (primaryType === 'medical_center') return 'Medizinisches Versorgungszentrum';
    if (primaryType === 'medical_clinic') return 'Klinik / MVZ';
    return 'Arztpraxis';
  }

  function readLat(location) {
    if (!location) return NaN;
    return typeof location.lat === 'function' ? Number(location.lat()) : Number(location.lat);
  }

  function readLng(location) {
    if (!location) return NaN;
    return typeof location.lng === 'function' ? Number(location.lng()) : Number(location.lng);
  }

  function haversineKm(a, b, c, d) {
    const R = 6371.0088;
    const rad = (v) => v * Math.PI / 180;
    const x = rad(c - a);
    const y = rad(d - b);
    const q = Math.sin(x / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(y / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  }

  function friendlyError(error) {
    const text = String(error?.message || error || 'Unbekannter Fehler');
    if (/ApiNotActivated|REQUEST_DENIED|not authorized|billing|RefererNotAllowed/i.test(text)) {
      return 'API-Key, Places API (New), Maps JavaScript API oder Abrechnung prüfen.';
    }
    return text;
  }
})();
