(() => {
  'use strict';

  const CONFIG = {
    address: 'Marwitzer Str. 67, 13589 Berlin',
    radiusMeters: 10000,
    dataUrl: './data/doctors.json',
    fallbackCenter: [52.5738, 13.1568],
    fallbackZoom: 12,
  };

  const state = {
    data: null,
    filtered: [],
    map: null,
    markerLayer: null,
    radiusLayer: null,
    homeMarker: null,
    markerById: new Map(),
    activeId: null,
  };

  const els = {
    search: document.getElementById('searchInput'),
    specialty: document.getElementById('specialtySelect'),
    distance: document.getElementById('distanceSelect'),
    list: document.getElementById('doctorList'),
    count: document.getElementById('resultCount'),
    status: document.getElementById('dataStatus'),
    reload: document.getElementById('reloadButton'),
    listToggle: document.getElementById('listToggle'),
    sidebar: document.getElementById('sidebar'),
    closeList: document.getElementById('closeList'),
    detailSheet: document.getElementById('detailSheet'),
    detailContent: document.getElementById('detailContent'),
    closeDetails: document.getElementById('closeDetails'),
    backdrop: document.getElementById('sheetBackdrop'),
  };

  initMap();
  bindEvents();
  loadData();
  registerServiceWorker();

  function initMap() {
    state.map = L.map('map', {
      zoomControl: true,
      preferCanvas: true,
      minZoom: 9,
      maxZoom: 19,
    }).setView(CONFIG.fallbackCenter, CONFIG.fallbackZoom);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
    }).addTo(state.map);

    state.markerLayer = L.layerGroup().addTo(state.map);
  }

  function bindEvents() {
    els.search.addEventListener('input', applyFilters);
    els.specialty.addEventListener('change', applyFilters);
    els.distance.addEventListener('change', applyFilters);
    els.reload.addEventListener('click', () => loadData(true));
    els.listToggle.addEventListener('click', () => els.sidebar.classList.toggle('open'));
    els.closeList.addEventListener('click', () => els.sidebar.classList.remove('open'));
    els.closeDetails.addEventListener('click', closeDetails);
    els.backdrop.addEventListener('click', closeDetails);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeDetails();
        els.sidebar.classList.remove('open');
      }
    });
  }

  async function loadData(force = false) {
    setStatus('Daten werden geladen …');
    try {
      const url = force ? `${CONFIG.dataUrl}?t=${Date.now()}` : CONFIG.dataUrl;
      const response = await fetch(url, { cache: force ? 'no-store' : 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.doctors)) throw new Error('Ungültiges Datenformat');
      state.data = data;
      renderAll();
      const updated = data.updatedAt ? new Date(data.updatedAt) : null;
      const ageDays = updated ? (Date.now() - updated.getTime()) / 86400000 : Infinity;
      const label = updated
        ? `${data.doctors.length} Einträge · Stand ${formatDate(updated)}`
        : `${data.doctors.length} Einträge · noch kein Wochenlauf`;
      setStatus(label, ageDays <= 8 ? 'ok' : 'warn');
    } catch (error) {
      console.error(error);
      state.data = { home: null, doctors: [], updatedAt: null };
      renderAll();
      setStatus('Noch keine Ärztedaten vorhanden – GitHub-Workflow einmal starten.', 'warn');
    }
  }

  function renderAll() {
    updateHomeLayer();
    populateSpecialties();
    applyFilters();
  }

  function updateHomeLayer() {
    const home = getHome();
    const latLng = [home.lat, home.lon];

    if (state.radiusLayer) state.radiusLayer.remove();
    if (state.homeMarker) state.homeMarker.remove();

    state.radiusLayer = L.circle(latLng, {
      radius: CONFIG.radiusMeters,
      color: '#4dd4b0',
      weight: 1.5,
      opacity: .8,
      fillColor: '#4dd4b0',
      fillOpacity: .055,
      interactive: false,
    }).addTo(state.map);

    state.homeMarker = L.marker(latLng, {
      icon: divIcon('home', '⌂'),
      zIndexOffset: 1000,
      title: 'Startpunkt',
    }).addTo(state.map).bindTooltip(`Startpunkt: ${CONFIG.address}`);

    state.map.fitBounds(state.radiusLayer.getBounds(), { padding: [20, 20] });
  }

  function getHome() {
    const home = state.data?.home;
    if (home && Number.isFinite(Number(home.lat)) && Number.isFinite(Number(home.lon))) {
      return { lat: Number(home.lat), lon: Number(home.lon) };
    }
    return { lat: CONFIG.fallbackCenter[0], lon: CONFIG.fallbackCenter[1] };
  }

  function populateSpecialties() {
    const current = els.specialty.value;
    const specialties = new Set();
    for (const doctor of state.data?.doctors || []) {
      for (const specialty of doctor.specialties || []) {
        if (specialty) specialties.add(specialty);
      }
    }
    const options = [...specialties].sort((a, b) => a.localeCompare(b, 'de'));
    els.specialty.innerHTML = '<option value="all">Alle Fachrichtungen</option>' +
      options.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join('');
    if (options.includes(current)) els.specialty.value = current;
  }

  function applyFilters() {
    const doctors = state.data?.doctors || [];
    const query = normalize(els.search.value);
    const specialty = els.specialty.value;
    const maxDistance = Number(els.distance.value || 10);

    state.filtered = doctors.filter((doctor) => {
      if (Number(doctor.distanceKm) > maxDistance) return false;
      if (specialty !== 'all' && !(doctor.specialties || []).includes(specialty)) return false;
      if (!query) return true;
      const haystack = normalize([
        doctor.name,
        doctor.type,
        doctor.address,
        ...(doctor.specialties || []),
      ].filter(Boolean).join(' '));
      return haystack.includes(query);
    });

    renderMarkers();
    renderList();
  }

  function renderMarkers() {
    state.markerLayer.clearLayers();
    state.markerById.clear();
    for (const doctor of state.filtered) {
      if (!Number.isFinite(Number(doctor.lat)) || !Number.isFinite(Number(doctor.lon))) continue;
      const kind = markerKind(doctor);
      const marker = L.marker([doctor.lat, doctor.lon], {
        icon: divIcon(kind, markerEmoji(kind)),
        title: doctor.name,
        riseOnHover: true,
      }).addTo(state.markerLayer);
      marker.on('click', () => selectDoctor(doctor.id));
      marker.bindTooltip(`${doctor.name} · ${formatDistance(doctor.distanceKm)}`, { direction: 'top', offset: [0, -14] });
      state.markerById.set(doctor.id, marker);
    }
  }

  function renderList() {
    els.count.textContent = `${state.filtered.length} ${state.filtered.length === 1 ? 'Treffer' : 'Treffer'}`;
    if (!state.filtered.length) {
      els.list.innerHTML = '<div class="empty-state">Keine passenden Einträge im gewählten Filter.<br>Die Karte nutzt freie OpenStreetMap-Daten; einzelne Praxen können dort fehlen.</div>';
      return;
    }

    els.list.innerHTML = state.filtered.map((doctor) => {
      const kind = markerKind(doctor);
      const subtitle = (doctor.specialties?.length ? doctor.specialties.join(', ') : doctor.type || 'Arztpraxis');
      return `
        <button class="doctor-card ${doctor.id === state.activeId ? 'active' : ''}" type="button" data-id="${escapeAttr(doctor.id)}">
          <span class="doctor-icon" aria-hidden="true">${markerEmoji(kind)}</span>
          <span>
            <h3>${escapeHtml(doctor.name || 'Unbenannte Praxis')}</h3>
            <p>${escapeHtml(subtitle)}</p>
          </span>
          <span class="distance">${formatDistance(doctor.distanceKm)}</span>
        </button>`;
    }).join('');

    els.list.querySelectorAll('.doctor-card').forEach((button) => {
      button.addEventListener('click', () => selectDoctor(button.dataset.id));
    });
  }

  function selectDoctor(id) {
    const doctor = (state.data?.doctors || []).find((item) => item.id === id);
    if (!doctor) return;
    state.activeId = id;
    renderList();
    const marker = state.markerById.get(id);
    if (marker) state.map.panTo(marker.getLatLng(), { animate: true });
    showDetails(doctor);
    if (window.innerWidth <= 840) els.sidebar.classList.remove('open');
  }

  function showDetails(doctor) {
    const specialty = doctor.specialties?.length ? doctor.specialties.join(', ') : (doctor.type || 'Arztpraxis');
    const hasRating = doctor.rating !== null && doctor.rating !== undefined && String(doctor.rating).trim() !== '' && Number.isFinite(Number(doctor.rating)) && Number(doctor.rating) > 0;
    const rating = hasRating
      ? `<span class="rating">★ ${Number(doctor.rating).toFixed(1)}${doctor.ratingCount ? ` · ${doctor.ratingCount} Bewertungen` : ''}</span>`
      : 'Keine Bewertung in der freien Datenquelle';
    const encodedName = encodeURIComponent(`${doctor.name || ''} ${doctor.address || ''}`.trim());
    const routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${doctor.lat},${doctor.lon}`)}`;
    const reviewSearchUrl = `https://www.google.com/search?q=${encodedName}+Bewertungen`;

    els.detailContent.innerHTML = `
      <h2>${escapeHtml(doctor.name || 'Unbenannte Praxis')}</h2>
      <div class="detail-subtitle">${escapeHtml(specialty)} · ${formatDistance(doctor.distanceKm)}</div>
      <div class="detail-grid">
        <div class="info-box wide"><div class="info-label">Adresse</div><div class="info-value">${escapeHtml(doctor.address || 'Nicht hinterlegt')}</div></div>
        <div class="info-box"><div class="info-label">Öffnungszeiten</div><div class="info-value">${escapeHtml(formatOpeningHours(doctor.openingHours))}</div></div>
        <div class="info-box"><div class="info-label">Bewertung</div><div class="info-value">${rating}</div></div>
        <div class="info-box"><div class="info-label">Telefon</div><div class="info-value">${doctor.phone ? `<a href="tel:${escapeAttr(doctor.phone)}">${escapeHtml(doctor.phone)}</a>` : 'Nicht hinterlegt'}</div></div>
        <div class="info-box"><div class="info-label">Barrierefreiheit</div><div class="info-value">${escapeHtml(formatWheelchair(doctor.wheelchair))}</div></div>
      </div>
      <div class="action-row">
        <a class="action-link primary" href="${routeUrl}" target="_blank" rel="noopener">↗ Route</a>
        ${doctor.phone ? `<a class="action-link" href="tel:${escapeAttr(doctor.phone)}">☎ Anrufen</a>` : ''}
        ${doctor.website ? `<a class="action-link" href="${escapeAttr(safeUrl(doctor.website))}" target="_blank" rel="noopener">⌂ Webseite</a>` : ''}
        <a class="action-link" href="${reviewSearchUrl}" target="_blank" rel="noopener">★ Bewertungen suchen</a>
      </div>
      <div class="source-note">Quelle der Praxisdaten: OpenStreetMap/Overpass. Bewertungen erscheinen nur, wenn sie als frei nutzbarer Datensatzwert vorhanden sind. Angaben bitte vor einem Arztbesuch auf der Praxiswebseite prüfen.</div>`;

    els.detailSheet.classList.add('open');
    els.detailSheet.setAttribute('aria-hidden', 'false');
    els.backdrop.hidden = false;
  }

  function closeDetails() {
    state.activeId = null;
    els.detailSheet.classList.remove('open');
    els.detailSheet.setAttribute('aria-hidden', 'true');
    els.backdrop.hidden = true;
    renderList();
  }

  function divIcon(kind, emoji) {
    return L.divIcon({
      className: '',
      html: `<div class="marker-pin ${kind}"><span>${emoji}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 28],
      tooltipAnchor: [0, -20],
    });
  }

  function markerKind(doctor) {
    const type = normalize(doctor.type);
    if (type.includes('zahn')) return 'dentist';
    if (type.includes('klinik') || type.includes('mvz') || type.includes('medizinisches versorgungszentrum') || type.includes('krankenhaus')) return 'clinic';
    return 'practice';
  }

  function markerEmoji(kind) {
    if (kind === 'dentist') return '🦷';
    if (kind === 'clinic') return '✚';
    if (kind === 'home') return '⌂';
    return '🩺';
  }

  function formatOpeningHours(value) {
    if (!value) return 'Nicht hinterlegt';
    return String(value).replace(/;/g, '; ');
  }

  function formatWheelchair(value) {
    if (value === 'yes') return 'Rollstuhlgerecht';
    if (value === 'limited') return 'Teilweise rollstuhlgerecht';
    if (value === 'no') return 'Nicht rollstuhlgerecht';
    return 'Keine Angabe';
  }

  function safeUrl(value) {
    try {
      const url = new URL(value.startsWith('http') ? value : `https://${value}`);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
    } catch {
      return '#';
    }
  }

  function formatDistance(value) {
    const distance = Number(value);
    if (!Number.isFinite(distance)) return '–';
    return distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1).replace('.', ',')} km`;
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function setStatus(text, mode = '') {
    els.status.textContent = text;
    els.status.className = `status-chip ${mode}`.trim();
  }

  function normalize(value) {
    return String(value || '').toLocaleLowerCase('de').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service Worker:', error));
    }
  }
})();
