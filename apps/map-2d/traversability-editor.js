/* Manual annotations, persisted only in this browser; never presented as sensors. */
(function () {
  'use strict';
  const STORAGE_KEY = 'peixonautas.mars.traversability.v1';
  const names = { blocked: 'Blocked', difficult: 'Difficult', normal: 'Normal', unknown: 'Unknown' };
  const colors = { blocked: '#ff5b63', difficult: '#ff9c36', normal: '#3bd681', unknown: '#f4d35e' };
  function createEditor({ map, onChange, onDrawStart, onDrawEnd }) {
    const api = globalThis.PeixonautasNavigation;
    const el = id => document.getElementById(id);
    const message = text => { el('annotationStatus').textContent = text; };
    const layer = L.layerGroup().addTo(map), draftLayer = L.layerGroup().addTo(map);
    let areas = [], drawing = false, vertices = [], doubleClickEnabled = false;
    let initialMessage = '';
    const defaults = api.normalizeTraversability();
    let restored = defaults;
    let restoredWeight = 1;
    const validWeight = value => {
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Invalid traversability weight.');
      return value;
    };
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        if (stored.length > 1000000) throw new Error('File too large.');
        const data = JSON.parse(stored);
        if (data.version !== 1 || data.planet !== 'Mars') throw new Error('Unknown format.');
        areas = api.validateAnnotations(data.areas);
        restored = api.normalizeTraversability(data.policy);
        restoredWeight = validWeight(data.terrainWeight ?? 1);
      }
    } catch { areas = []; restored = defaults; initialMessage = 'Could not restore saved areas. You can import a valid export.'; }
    el('useTraversability').checked = restored.enabled;
    el('weightTerrain').value = restoredWeight;
    el('difficultCost').value = restored.difficultCost;
    el('unknownCost').value = restored.unknownCost;
    el('unknownPolicy').value = restored.unknownPolicy;
    el('blockedMargin').value = restored.marginM;

    function getSnapshot() {
      for (const id of ['difficultCost', 'unknownCost', 'blockedMargin', 'weightTerrain']) {
        if (!el(id).checkValidity() || el(id).value.trim() === '') throw new Error('Check manual area costs and margin.');
      }
      return { areas: api.validateAnnotations(areas), terrainWeight: validWeight(Number(el('weightTerrain').value)), policy: api.normalizeTraversability({
        enabled: el('useTraversability').checked, difficultCost: Number(el('difficultCost').value),
        unknownCost: Number(el('unknownCost').value), unknownPolicy: el('unknownPolicy').value,
        marginM: Number(el('blockedMargin').value)
      }) };
    }
    function changed(text) {
      onChange();
      try {
        const snapshot = getSnapshot();
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, planet: 'Mars', ...snapshot })); }
        catch { message('Could not save in this browser. Export the areas to keep them.'); return; }
        message(text || 'Configuration saved in this browser. Recalculate the route.');
      } catch (error) { message(error.message); }
    }
    function renderAreas() {
      layer.clearLayers();
      el('annotationList').replaceChildren();
      for (const area of areas) {
        const label = document.createElement('span');
        label.textContent = area.label + ' — ' + names[area.type] + ' (manual interpretation)';
        const polygon = L.polygon(area.ring.map(([lon, lat]) => [lat, lon]), {
          color: colors[area.type], weight: 2, fillOpacity: 0.18, interactive: true
        }).bindTooltip(label).addTo(layer);
        const item = document.createElement('li');
        item.dataset.areaId = area.id;
        const title = document.createElement('span');
        title.className = 'annotation-title'; title.textContent = area.label;
        item.appendChild(title);
        const type = document.createElement('select');
        type.setAttribute('aria-label', 'Classification of ' + area.label);
        for (const [value, text] of Object.entries(names)) {
          const option = document.createElement('option'); option.value = value; option.textContent = text;
          type.appendChild(option);
        }
        type.value = area.type;
        type.onchange = () => { area.type = type.value; renderAreas(); changed('Classification updated. Recalculate the route.'); };
        item.appendChild(type);
        const controls = document.createElement('div'); controls.className = 'route-controls';
        const locate = document.createElement('button'); locate.type = 'button'; locate.className = 'preset-btn'; locate.textContent = 'View area';
        locate.onclick = () => map.fitBounds(polygon.getBounds(), { padding: [60, 60], maxZoom: 13 });
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'preset-btn'; remove.textContent = 'Remove';
        remove.dataset.action = 'remove';
        remove.onclick = () => { areas = areas.filter(a => a.id !== area.id); renderAreas(); changed('Area removed. Recalculate the route.'); };
        controls.append(locate, remove); item.appendChild(controls); el('annotationList').appendChild(item);
      }
      if (!areas.length) message('No manual areas. When enabled, unclassified terrain will be unknown.');
    }
    function renderDraft() {
      draftLayer.clearLayers();
      const positions = vertices.map(([lon, lat]) => [lat, lon]);
      if (positions.length >= 3) L.polygon(positions, { color: '#b9c4d4', dashArray: '5 5', fillOpacity: 0.08, interactive: false }).addTo(draftLayer);
      else if (positions.length) L.polyline(positions, { color: '#b9c4d4', interactive: false }).addTo(draftLayer);
      for (const position of positions) L.circleMarker(position, { radius: 4, color: '#fff', interactive: false }).addTo(draftLayer);
      el('finishAnnotation').disabled = positions.length < 3;
      el('undoAnnotationVertex').disabled = !positions.length;
      message(positions.length + ' vertices. Click the map and select Finish area; Esc cancels.');
    }
    function cancelDrawing(notify = true) {
      if (!drawing) return;
      drawing = false; vertices = []; draftLayer.clearLayers();
      if (doubleClickEnabled) map.doubleClickZoom.enable();
      el('drawAnnotation').setAttribute('aria-pressed', 'false');
      for (const id of ['finishAnnotation', 'undoAnnotationVertex', 'cancelAnnotation']) el(id).disabled = true;
      map.getContainer().style.cursor = '';
      if (notify) { message('Draft canceled. Existing areas preserved.'); onDrawEnd(); }
    }
    el('drawAnnotation').onclick = () => {
      if (drawing) { cancelDrawing(); return; }
      if (areas.length >= 50) { message('Limit of 50 areas reached. Remove one before drawing.'); return; }
      onDrawStart();
      drawing = true; vertices = []; doubleClickEnabled = map.doubleClickZoom.enabled(); map.doubleClickZoom.disable();
      el('drawAnnotation').setAttribute('aria-pressed', 'true'); el('cancelAnnotation').disabled = false;
      map.getContainer().style.cursor = 'crosshair'; renderDraft();
    };
    el('cancelAnnotation').onclick = () => cancelDrawing();
    el('undoAnnotationVertex').onclick = () => { vertices.pop(); renderDraft(); };
    el('finishAnnotation').onclick = () => {
      try {
        const item = { id: crypto.randomUUID(), label: el('annotationLabel').value.trim() || names[el('annotationType').value] + ' ' + (areas.length + 1),
          type: el('annotationType').value, ring: vertices, createdAt: new Date().toISOString() };
        const validated = api.validateAnnotations([...areas, item]);
        cancelDrawing(false); areas = validated; renderAreas();
        changed('Manual area saved. Enable the layer and recalculate to use it.');
      } catch (error) { message(error.message); }
    };
    map.on('click', event => {
      if (!drawing) return;
      const { lat, lng } = event.latlng;
      if (Math.abs(lat) > 75 || Math.abs(lng) > 180) { message('Draw between latitudes ±75° and longitudes ±180°.'); return; }
      if (vertices.length >= 128) { message('Limit of 128 vertices. Finish or undo a vertex.'); return; }
      const previous = vertices.at(-1);
      if (previous && previous[0] === lng && previous[1] === lat) return;
      vertices.push([lng, lat]); renderDraft();
    });
    document.addEventListener('keydown', event => { if (drawing && event.key === 'Escape') { event.preventDefault(); cancelDrawing(); } });
    for (const id of ['useTraversability', 'difficultCost', 'unknownCost', 'unknownPolicy', 'blockedMargin', 'weightTerrain']) {
      el(id).addEventListener('input', () => changed());
    }
    el('exportAnnotations').onclick = () => {
      try {
        const snapshot = getSnapshot();
        const data = { type: 'FeatureCollection', planet: 'Mars', schemaVersion: 1,
          properties: { coordinateSystem: 'Mars planetocentric latitude / east longitude, degrees',
            provenance: 'manual-interpretation', policy: snapshot.policy, terrainWeight: snapshot.terrainWeight },
          features: snapshot.areas.map(a => ({ type: 'Feature', id: a.id,
            properties: { label: a.label, type: a.type, provenance: 'manual-interpretation', createdAt: a.createdAt },
            geometry: { type: 'Polygon', coordinates: [[...a.ring, a.ring[0]]] } })) };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'mars-manual-traversability.geojson'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { message(error.message); }
    };
    el('importAnnotations').onchange = async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        if (file.size > 1000000) throw new Error('Import a file up to 1 MB.');
        const data = JSON.parse(await file.text());
        if (data.type !== 'FeatureCollection' || data.planet !== 'Mars' || data.schemaVersion !== 1 || !Array.isArray(data.features)) {
          throw new Error('Use a Mars area collection exported by this app.');
        }
        const imported = api.validateAnnotations(data.features.map(feature => {
          if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Polygon'
              || !Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length !== 1) {
            throw new Error('Only simple polygons without holes are supported.');
          }
          return { id: feature.id, label: feature.properties?.label, type: feature.properties?.type,
            ring: feature.geometry.coordinates[0], createdAt: feature.properties?.createdAt };
        }));
        const policy = api.normalizeTraversability(data.properties?.policy);
        const terrainWeight = validWeight(data.properties?.terrainWeight ?? 1);
        cancelDrawing(false); areas = imported;
        el('useTraversability').checked = policy.enabled; el('difficultCost').value = policy.difficultCost;
        el('unknownCost').value = policy.unknownCost; el('unknownPolicy').value = policy.unknownPolicy;
        el('blockedMargin').value = policy.marginM;
        el('weightTerrain').value = terrainWeight;
        renderAreas(); changed('Areas and policy imported, replacing the previous ones. Recalculate the route.');
      } catch (error) { message('Import rejected: ' + error.message); }
      finally { event.target.value = ''; }
    };
    renderAreas();
    if (initialMessage) message(initialMessage);
    return { getSnapshot, cancelDrawing, isDrawing: () => drawing };
  }
  globalThis.PeixonautasTraversability = { createEditor };
})();
