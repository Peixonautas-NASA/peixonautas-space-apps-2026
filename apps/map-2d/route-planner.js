/* Integrates the shared numerical planner with Leaflet; works on file:// and HTTP. */
(function () {
  'use strict';
  const api = globalThis.PeixonautasNavigation;
  const terrain = globalThis.GALE_TERRAIN_DATA;
  const element = id => document.getElementById(id);
  const status = text => { element('routeStatus').textContent = text; };
  if (!api || !terrain) {
    status('Gale data unavailable. Keep the data and packages folders alongside apps.');
    element('calculateRoute').disabled = true;
    return;
  }
  const localGrid = { ...terrain, elevations: Float32Array.from(terrain.elevations, v => v === null ? NaN : v) };
  let grid = localGrid;
  delete globalThis.GALE_TERRAIN_DATA;
  let bounds = [[terrain.bounds.latMin, terrain.bounds.lonMin], [terrain.bounds.latMax, terrain.bounds.lonMax]];
  const areaRectangle = L.rectangle(bounds, { color: '#ffb454', weight: 2, dashArray: '6 6', fillOpacity: 0.025, interactive: false }).addTo(map);
  const markers = {};
  const endpoints = {};
  let selecting = null, routeLine = null, worker = null, requestId = 0, lastResult = null, controller = null, editor = null, environmentEditor = null;
  const automatic = () => element('terrainMode').value === 'auto';

  function clearResult() {
    requestId++;
    if (controller) controller.abort();
    controller = null;
    if (worker) worker.terminate();
    worker = null;
    if (routeLine) map.removeLayer(routeLine);
    routeLine = null;
    lastResult = null;
    element('routeMetrics').textContent = '';
    element('exportRoute').disabled = true;
    element('calculateRoute').disabled = false;
  }

  function setSelection(which) {
    if (which) editor?.cancelDrawing();
    selecting = selecting === which ? null : which;
    element('selectRouteA').setAttribute('aria-pressed', String(selecting === 'A'));
    element('selectRouteB').setAttribute('aria-pressed', String(selecting === 'B'));
    map.getContainer().style.cursor = selecting ? 'crosshair' : '';
    if (selecting) status((automatic() ? 'Click the map' : 'Click inside the outlined area') + ' to select ' + selecting + '.');
  }

  function setEndpoint(which, lat, lon) {
    const cell = api.latLonToCell(grid, lat, lon);
    const validCoordinate = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 75 && Math.abs(lon) <= 180;
    const inGrid = cell.x >= 0 && cell.y >= 0 && cell.x < grid.width && cell.y < grid.height
      && Number.isFinite(grid.elevations[cell.y * grid.width + cell.x]);
    if (!validCoordinate || (!automatic() && !inGrid)) {
      status('Choose a point within the area of interest with valid elevation.');
      if (markers[which]) markers[which].setLatLng(endpoints[which].position);
      return false;
    }
    clearResult();
    const point = automatic() ? { lat, lon } : api.cellToLatLon(grid, cell);
    const position = [point.lat, point.lon];
    endpoints[which] = { cell: inGrid ? cell : null, position, requestedPosition: [lat, lon] };
    if (markers[which]) markers[which].setLatLng(position);
    else {
      markers[which] = L.marker(position, {
        draggable: true,
        icon: L.divIcon({ className: '', html: '<div class="route-point route-point-' + which.toLowerCase() + '">' + which + '</div>',
          iconSize: [28, 28], iconAnchor: [14, 14] }),
        title: 'Point ' + which
      }).addTo(map);
      markers[which].on('dragstart', () => { editor?.cancelDrawing(); clearResult(); });
      markers[which].on('dragend', event => {
        const p = event.target.getLatLng();
        setEndpoint(which, p.lat, p.lng);
      });
    }
    updateEndpointLabels();
    status(automatic() ? 'Points selected. Calculate to fetch terrain.' : 'Points snapped to 30 m cell centers. Ready to calculate.');
    return true;
  }

  function updateEndpointLabels() {
    element('routeEndpoints').textContent = ['A', 'B'].filter(k => endpoints[k]).map(k => {
      const [a, b] = endpoints[k].position;
      element('routeLat' + k).value = endpoints[k].requestedPosition[0];
      element('routeLon' + k).value = endpoints[k].requestedPosition[1];
      return k + ': ' + a.toFixed(5) + '°, ' + b.toFixed(5) + '°';
    }).join(' | ');
  }

  function applyTerrain(data) {
    grid = { ...data, elevations: Float32Array.from(data.elevations, v => v === null ? NaN : v) };
    bounds = [[data.bounds.latMin, data.bounds.lonMin], [data.bounds.latMax, data.bounds.lonMax]];
    areaRectangle.setBounds(bounds);
    for (const which of ['A', 'B']) {
      if (!endpoints[which]) continue;
      const [lat, lon] = endpoints[which].requestedPosition;
      const cell = api.latLonToCell(grid, lat, lon);
      endpoints[which].cell = cell;
      if (cell.x >= 0 && cell.y >= 0 && cell.x < grid.width && cell.y < grid.height) {
        const point = api.cellToLatLon(grid, cell);
        endpoints[which].position = [point.lat, point.lon];
        markers[which].setLatLng(endpoints[which].position);
      }
    }
    updateEndpointLabels();
    const resolution = Math.round(grid.pixelSizeM).toLocaleString('en-US');
    element('terrainSourceInfo').textContent = grid.name + ' · ' + resolution + ' m/cell'
      + (data.cacheHit ? ' · cached area' : '')
      + (data.selection?.fallbackReasons?.length ? ' · fallback source after unavailability' : '');
    element('terrainSourceLink').href = grid.source.doi ? 'https://doi.org/' + grid.source.doi : grid.source.url;
    element('terrainSourceLink').textContent = 'Source: ' + (grid.source.title || grid.name);
    element('terrainSourceLink').hidden = false;
  }

  function readWeights() {
    editor.getSnapshot();
    const controls = ['weightDistance', 'weightSlope', 'weightAscent', 'weightTerrain', 'routeMaxSlope'];
    for (const id of controls) {
      if (!element(id).checkValidity() || element(id).value.trim() === '') throw new Error('Check the weights and slope limit.');
    }
    return { ...environmentEditor.getSnapshot().weights, distance: Number(element('weightDistance').value), slope: Number(element('weightSlope').value),
      ascent: Number(element('weightAscent').value), terrain: Number(element('weightTerrain').value), maxSlopeDeg: Number(element('routeMaxSlope').value) };
  }

  function showResult(result) {
    const messages = {
      'environment-data-missing': 'Environmental data is missing at A or B. Import a grid covering the points, choose a scenario, or set the corresponding weight to zero.',
      'outside-area': 'One endpoint is outside the loaded terrain.',
      'invalid-endpoint': 'One endpoint is blocked by the manual policy, lacks elevation support, or exceeds the slope limit.',
      'no-path': 'No route found in this crop with the selected limits, blocks and environmental coverage. Missing active environmental data blocks passage. Detours outside this area may exist.'
    };
    if (result.status !== 'ok') { status(messages[result.status] || 'Could not calculate the route.'); return; }
    const points = result.cells.map(cell => {
      const p = api.cellToLatLon(grid, cell);
      return [p.lat, p.lon];
    });
    routeLine = L.polyline(points, { color: '#39e7ff', weight: 5, opacity: 0.95, smoothFactor: 0, interactive: false }).addTo(map);
    lastResult = result;
    element('exportRoute').disabled = false;
    const format = value => value.toLocaleString('en-US', { maximumFractionDigits: 1 });
    element('routeMetrics').textContent = 'Horizontal distance: ' + format(result.distanceM / 1000) + ' km'
      + ' | Ascent: ' + format(result.ascentM) + ' m | Descent: ' + format(result.descentM) + ' m'
      + ' | Estimated maximum slope: ' + format(result.maxSlopeDeg) + '°'
      + ' | Weighted cost: ' + format(result.cost)
      + ' (distance ' + format(result.costParts.distance) + ', slope ' + format(result.costParts.slope)
      + ', ascent ' + format(result.costParts.ascent) + ', traversability ' + format(result.costParts.terrain || 0)
      + ', radiation ' + format(result.costParts.radiation || 0) + ', temperature ' + format(result.costParts.temperature || 0)
      + ', magnetism ' + format(result.costParts.magnetism || 0) + ').'
      + (result.traversability?.enabled ? ' Manual layer enabled: ' + format(result.traversability.classDistanceM.difficult / 1000)
        + ' km difficult; ' + format(result.traversability.classDistanceM.unknown / 1000) + ' km unknown.' : ' Manual layer off.');
    if (result.environment?.enabled) {
      const e = result.environment;
      element('routeMetrics').textContent += ' Environment: estimated time ' + format(e.durationHours) + ' h (constant speed)'
        + (e.doseUSv !== null ? '; estimated model/scenario dose ' + format(e.doseUSv) + ' µSv' : '')
        + (e.temperatureMinC !== null ? '; sampled temperature ' + format(e.temperatureMinC) + ' to ' + format(e.temperatureMaxC) + ' °C' : '')
        + (e.magneticMaxNT !== null ? '; maximum sampled field ' + format(e.magneticMaxNT) + ' nT' : '')
        + '. ' + Object.entries(e.layers).map(([key, layer]) => key + ': ' + layer.source.title
          + (layer.effectiveResolutionM ? ' (effective resolution ≥ ' + format(layer.effectiveResolutionM) + ' m)' : ' (uniform simulation)')).join('; ')
        + '. Imported provenance declared by the user; static fields, no conversion of magnetism into radiation protection.';
    }
    status(result.cells.length === 1 ? 'A and B are in the same cell.' : 'Route calculated on the DTM. Grid spacing: '
      + Math.round(grid.pixelSizeM).toLocaleString('en-US') + ' m; comparative cost, no energy estimate.'
      + (grid.pixelSizeM > 100 ? ' Regional route: does not resolve local slopes and obstacles.' : ''));
    if (!map.getBounds().contains(endpoints.A.position) || !map.getBounds().contains(endpoints.B.position)) {
      map.fitBounds(bounds, { padding: [25, 25], animate: false });
    }
  }

  async function calculate() {
    clearResult();
    if (!endpoints.A || !endpoints.B) { status('Choose points A and B.'); return; }
    const currentRequest = requestId;
    try {
      if (editor.isDrawing()) throw new Error('Finish or cancel drawing the area before calculating.');
      const weights = readWeights();
      if (automatic() && !/^https?:$/.test(location.protocol)) {
        throw new Error('To fetch terrain, start the service and open http://127.0.0.1:7878/. Local Gale is still available in this file.');
      }
      controller = new AbortController();
      const signal = controller.signal;
      element('calculateRoute').disabled = true;
      const attempts = automatic() ? 3 : 1;
      for (let expansion = 0; expansion < attempts; expansion++) {
        if (automatic()) {
          status(expansion ? 'No path in the previous crop. Expanding the terrain search...' : 'Fetching elevation for A and B. The first request may take a few minutes...');
          const [latA, lonA] = endpoints.A.requestedPosition;
          const [latB, lonB] = endpoints.B.requestedPosition;
          const response = await fetch('/api/terrain', { method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start: { lat: latA, lon: lonA }, goal: { lat: latB, lon: lonB }, expansion }) });
          if (!response.ok) {
            let message = 'Terrain service unavailable. Open the app through the local service.';
            try { message = (await response.json()).error || message; } catch { /* Non-service static host. */ }
            throw new Error(message);
          }
          const data = await response.json();
          if (requestId !== currentRequest) return;
          applyTerrain(data);
        }
        status('Calculating A* on a grid of ' + Math.round(grid.pixelSizeM).toLocaleString('en-US') + ' m...');
        const result = await search(grid, weights, signal, currentRequest);
        if (requestId !== currentRequest) return;
        if (result.status === 'no-path' && expansion + 1 < attempts) continue;
        showResult(result);
        break;
      }
    } catch (error) {
      if (requestId === currentRequest && error.name !== 'AbortError') status(error.message);
    } finally {
      if (requestId === currentRequest) { controller = null; element('calculateRoute').disabled = false; }
    }
  }

  function search(activeGrid, weights, signal, currentRequest) {
    return new Promise((resolve, reject) => {
      const manual = editor.getSnapshot();
      const url = URL.createObjectURL(new Blob([api.createWorkerSource()], { type: 'text/javascript' }));
      let currentWorker;
      try { currentWorker = new Worker(url); } catch (error) { reject(error); return; }
      finally { URL.revokeObjectURL(url); }
      worker = currentWorker;
      const finish = (error, result) => {
        signal.removeEventListener('abort', abort);
        currentWorker.terminate();
        if (worker === currentWorker) worker = null;
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(new DOMException('Calculation canceled.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      currentWorker.onmessage = event => {
        if (event.data.requestId !== currentRequest) return;
        finish(event.data.error ? new Error(event.data.error) : null, event.data.result);
      };
      currentWorker.onerror = () => finish(new Error('Route processing failed. Try again.'));
      const elevations = new Float32Array(activeGrid.elevations);
      currentWorker.postMessage({ requestId: currentRequest,
        grid: { width: activeGrid.width, height: activeGrid.height, stepXM: activeGrid.stepXM,
          stepYM: activeGrid.stepYM, stepXMByRow: activeGrid.stepXMByRow, elevations,
          originX: activeGrid.originX, originY: activeGrid.originY, pixelSizeM: activeGrid.pixelSizeM,
          projection: activeGrid.projection, annotations: manual.areas, traversability: manual.policy,
          environment: environmentEditor.getSnapshot().settings },
        start: endpoints.A.cell, goal: endpoints.B.cell, weights }, [elevations.buffer]);
    });
  }

  editor = globalThis.PeixonautasTraversability.createEditor({ map,
    onChange: () => { clearResult(); status('Traversability changed. Recalculate the route to apply the areas and policy.'); },
    onDrawStart: () => { setSelection(null); clearResult(); status('Drawing a manual area. Finish or cancel before calculating.'); },
    onDrawEnd: () => status('Drawing canceled. Choose points or calculate again.')
  });

  environmentEditor = globalThis.PeixonautasEnvironment.createEditor({ getGrid: () => grid,
    onChange: () => { clearResult(); status('Environmental weights or sources changed. Recalculate the route.'); } });

  element('selectRouteA').onclick = () => setSelection('A');
  element('selectRouteB').onclick = () => setSelection('B');
  element('focusRouteArea').onclick = () => map.fitBounds(bounds, { padding: [25, 25] });
  element('calculateRoute').onclick = calculate;
  element('terrainMode').onchange = () => {
    clearResult();
    if (automatic()) {
      element('terrainSourceLink').hidden = true;
      element('terrainSourceInfo').textContent = 'Source and resolution will be selected to cover A and B.';
      status('Choose A/B in another region or enter coordinates. Then calculate to fetch elevation.');
    } else {
      applyTerrain(localGrid);
      status('Local Gale selected. A and B must be within the outlined crop.');
    }
  };
  element('applyRouteCoordinates').onclick = () => {
    const ids = ['routeLatA', 'routeLonA', 'routeLatB', 'routeLonB'];
    if (ids.some(id => !element(id).checkValidity() || element(id).value.trim() === '')) {
      status('Check coordinates: latitude -75° to 75°, longitude -180° to 180°.'); return;
    }
    const [latA, lonA, latB, lonB] = ids.map(id => Number(element(id).value));
    if (!automatic()) {
      for (const [lat, lon] of [[latA, lonA], [latB, lonB]]) {
        const c = api.latLonToCell(grid, lat, lon);
        if (c.x < 0 || c.y < 0 || c.x >= grid.width || c.y >= grid.height
            || !Number.isFinite(grid.elevations[c.y * grid.width + c.x])) {
          status('These points are outside local Gale. Select Automatic mode to fetch another region.'); return;
        }
      }
    }
    setEndpoint('A', latA, lonA);
    setEndpoint('B', latB, lonB);
    map.fitBounds([endpoints.A.position, endpoints.B.position], { padding: [50, 50], maxZoom: 11 });
  };
  for (const id of ['weightDistance', 'weightSlope', 'weightAscent', 'routeMaxSlope']) {
    element(id).addEventListener('input', () => { clearResult(); status('Parameters changed. Calculate the route again.'); });
  }
  map.on('click', event => {
    if (!selecting) return;
    if (setEndpoint(selecting, event.latlng.lat, event.latlng.lng)) setSelection(selecting);
  });
  element('exportRoute').onclick = () => {
    if (!lastResult) return;
    const geojson = {
      type: 'Feature',
      properties: { terrainId: grid.id, sourceDoi: grid.source.doi, resolutionM: grid.pixelSizeM,
        sourceUrl: grid.source.url, sourceTitle: grid.source.title || grid.name,
        terrainSelection: grid.selection || { mode: 'bundled-local' },
        manualTraversability: editor.getSnapshot(), traversability: lastResult.traversability,
        environmentInput: environmentEditor.getSnapshot(), environment: lastResult.environment,
        coordinateSystem: 'Mars planetocentric latitude / east longitude, degrees',
        elevationReference: grid.source.terrainReference, weights: lastResult.weights,
        distanceM: lastResult.distanceM, ascentM: lastResult.ascentM, descentM: lastResult.descentM,
        maxSlopeDeg: lastResult.maxSlopeDeg, cost: lastResult.cost, costParts: lastResult.costParts,
        limitations: 'Regional prototype; optional manual terrain interpretation, no sensor-derived soil or weather validation.' },
      geometry: { type: 'LineString', coordinates: lastResult.cells.map(cell => {
        const p = api.cellToLatLon(grid, cell);
        return [p.lon, p.lat, cell.elevationM];
      }) }
    };
    if (geojson.geometry.coordinates.length === 1) geojson.geometry.coordinates.push([...geojson.geometry.coordinates[0]]);
    const url = URL.createObjectURL(new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = automatic() ? 'mars-route.geojson' : 'gale-route.geojson';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (map.hasLayer(jezeroHiRise)) map.removeLayer(jezeroHiRise);
  currentMarker.closePopup();
  setEndpoint('A', -4.59, 137.44);
  setEndpoint('B', -4.68, 137.42);
  document.getElementById('latInput').value = '-4.59';
  document.getElementById('lonInput').value = '137.44';
  currentMarker.setLatLng([-4.59, 137.44]).setPopupContent('Gale — regional planning area').closePopup();
  updateTelemetry(-4.59, 137.44);
  map.fitBounds(bounds, { padding: [25, 25], animate: false });
  async function initialize() {
    const initializationRequest = requestId;
    if (/^https?:$/.test(location.protocol)) {
      try {
        const response = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
        if (response.ok && (await response.json()).service === 'peixonautas-terrain') {
          if (requestId !== initializationRequest) return;
          element('terrainMode').value = 'auto';
        }
      } catch { /* Static hosting retains bundled Gale mode. */ }
    }
    if (requestId === initializationRequest) calculate();
  }
  initialize();
})();
