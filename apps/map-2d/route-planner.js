/* Integrates the shared numerical planner with Leaflet; works on file:// and HTTP. */
(function () {
  'use strict';
  const api = globalThis.PeixonautasNavigation;
  const terrain = globalThis.GALE_TERRAIN_DATA;
  const element = id => document.getElementById(id);
  const status = text => { element('routeStatus').textContent = text; };
  if (!api || !terrain) {
    status('Dados de Gale indisponíveis. Mantenha as pastas data e packages junto às apps.');
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
  let selecting = null, routeLine = null, worker = null, requestId = 0, lastResult = null, controller = null;
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
    selecting = selecting === which ? null : which;
    element('selectRouteA').setAttribute('aria-pressed', String(selecting === 'A'));
    element('selectRouteB').setAttribute('aria-pressed', String(selecting === 'B'));
    map.getContainer().style.cursor = selecting ? 'crosshair' : '';
    if (selecting) status((automatic() ? 'Clique no mapa' : 'Clique dentro da área delimitada') + ' para escolher ' + selecting + '.');
  }

  function setEndpoint(which, lat, lon) {
    const cell = api.latLonToCell(grid, lat, lon);
    const validCoordinate = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 75 && Math.abs(lon) <= 180;
    const inGrid = cell.x >= 0 && cell.y >= 0 && cell.x < grid.width && cell.y < grid.height
      && Number.isFinite(grid.elevations[cell.y * grid.width + cell.x]);
    if (!validCoordinate || (!automatic() && !inGrid)) {
      status('Escolha um ponto dentro da área de interesse com elevação válida.');
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
        title: 'Ponto ' + which
      }).addTo(map);
      markers[which].on('dragstart', clearResult);
      markers[which].on('dragend', event => {
        const p = event.target.getLatLng();
        setEndpoint(which, p.lat, p.lng);
      });
    }
    updateEndpointLabels();
    status(automatic() ? 'Pontos escolhidos. Calcule para buscar o terreno.' : 'Pontos ajustados aos centros das células de 30 m. Pronto para calcular.');
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
    const resolution = Math.round(grid.pixelSizeM).toLocaleString('pt-BR');
    element('terrainSourceInfo').textContent = grid.name + ' · ' + resolution + ' m/célula'
      + (data.cacheHit ? ' · área em cache' : '')
      + (data.selection?.fallbackReasons?.length ? ' · fonte alternativa após indisponibilidade' : '');
    element('terrainSourceLink').href = grid.source.doi ? 'https://doi.org/' + grid.source.doi : grid.source.url;
    element('terrainSourceLink').textContent = 'Fonte: ' + (grid.source.title || grid.name);
    element('terrainSourceLink').hidden = false;
  }

  function readWeights() {
    const controls = ['weightDistance', 'weightSlope', 'weightAscent', 'routeMaxSlope'];
    for (const id of controls) {
      if (!element(id).checkValidity() || element(id).value.trim() === '') throw new Error('Revise os pesos e o limite de inclinação.');
    }
    return { distance: Number(element('weightDistance').value), slope: Number(element('weightSlope').value),
      ascent: Number(element('weightAscent').value), maxSlopeDeg: Number(element('routeMaxSlope').value) };
  }

  function showResult(result) {
    const messages = {
      'outside-area': 'Um dos pontos está fora do terreno carregado.',
      'invalid-endpoint': 'Um dos pontos não tem suporte de elevação suficiente ou excede o limite de inclinação.',
      'no-path': 'Nenhuma rota encontrada dentro deste recorte com o limite escolhido. Isso não exclui desvios fora da área.'
    };
    if (result.status !== 'ok') { status(messages[result.status] || 'Não foi possível calcular a rota.'); return; }
    const points = result.cells.map(cell => {
      const p = api.cellToLatLon(grid, cell);
      return [p.lat, p.lon];
    });
    routeLine = L.polyline(points, { color: '#39e7ff', weight: 5, opacity: 0.95, smoothFactor: 0, interactive: false }).addTo(map);
    lastResult = result;
    element('exportRoute').disabled = false;
    const format = value => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    element('routeMetrics').textContent = 'Distância horizontal: ' + format(result.distanceM / 1000) + ' km'
      + ' | Subida: ' + format(result.ascentM) + ' m | Descida: ' + format(result.descentM) + ' m'
      + ' | Inclinação máxima estimada: ' + format(result.maxSlopeDeg) + '°'
      + ' | Custo ponderado: ' + format(result.cost)
      + ' (distância ' + format(result.costParts.distance) + ', inclinação ' + format(result.costParts.slope)
      + ', subida ' + format(result.costParts.ascent) + ').';
    status(result.cells.length === 1 ? 'A e B estão na mesma célula.' : 'Rota calculada no DTM. Grade de '
      + Math.round(grid.pixelSizeM).toLocaleString('pt-BR') + ' m; custo comparativo, sem estimativa de tempo ou energia.'
      + (grid.pixelSizeM > 100 ? ' Rota regional: não resolve inclinações e obstáculos locais.' : ''));
    if (!map.getBounds().contains(endpoints.A.position) || !map.getBounds().contains(endpoints.B.position)) {
      map.fitBounds(bounds, { padding: [25, 25], animate: false });
    }
  }

  async function calculate() {
    clearResult();
    if (!endpoints.A || !endpoints.B) { status('Escolha os pontos A e B.'); return; }
    const currentRequest = requestId;
    try {
      const weights = readWeights();
      if (automatic() && !/^https?:$/.test(location.protocol)) {
        throw new Error('Para buscar terreno, inicie o serviço e abra http://127.0.0.1:7878/. Gale local continua disponível neste arquivo.');
      }
      controller = new AbortController();
      const signal = controller.signal;
      element('calculateRoute').disabled = true;
      const attempts = automatic() ? 3 : 1;
      for (let expansion = 0; expansion < attempts; expansion++) {
        if (automatic()) {
          status(expansion ? 'Sem caminho no recorte anterior. Ampliando a busca de terreno...' : 'Buscando elevação para A e B. O primeiro acesso pode levar alguns minutos...');
          const [latA, lonA] = endpoints.A.requestedPosition;
          const [latB, lonB] = endpoints.B.requestedPosition;
          const response = await fetch('/api/terrain', { method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start: { lat: latA, lon: lonA }, goal: { lat: latB, lon: lonB }, expansion }) });
          if (!response.ok) {
            let message = 'Serviço de terreno indisponível. Abra a aplicação pelo serviço local.';
            try { message = (await response.json()).error || message; } catch { /* Non-service static host. */ }
            throw new Error(message);
          }
          const data = await response.json();
          if (requestId !== currentRequest) return;
          applyTerrain(data);
        }
        status('Calculando A* na grade de ' + Math.round(grid.pixelSizeM).toLocaleString('pt-BR') + ' m...');
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
      const abort = () => finish(new DOMException('Cálculo cancelado.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      currentWorker.onmessage = event => {
        if (event.data.requestId !== currentRequest) return;
        finish(event.data.error ? new Error(event.data.error) : null, event.data.result);
      };
      currentWorker.onerror = () => finish(new Error('Falha no processamento da rota. Tente novamente.'));
      const elevations = new Float32Array(activeGrid.elevations);
      currentWorker.postMessage({ requestId: currentRequest,
        grid: { width: activeGrid.width, height: activeGrid.height, stepXM: activeGrid.stepXM,
          stepYM: activeGrid.stepYM, stepXMByRow: activeGrid.stepXMByRow, elevations },
        start: endpoints.A.cell, goal: endpoints.B.cell, weights }, [elevations.buffer]);
    });
  }

  element('selectRouteA').onclick = () => setSelection('A');
  element('selectRouteB').onclick = () => setSelection('B');
  element('focusRouteArea').onclick = () => map.fitBounds(bounds, { padding: [25, 25] });
  element('calculateRoute').onclick = calculate;
  element('terrainMode').onchange = () => {
    clearResult();
    if (automatic()) {
      element('terrainSourceLink').hidden = true;
      element('terrainSourceInfo').textContent = 'A fonte e a resolução serão escolhidas para cobrir A e B.';
      status('Escolha A/B em outra região ou insira coordenadas. Depois, calcule para buscar a elevação.');
    } else {
      applyTerrain(localGrid);
      status('Gale local selecionado. A e B devem estar dentro do recorte delimitado.');
    }
  };
  element('applyRouteCoordinates').onclick = () => {
    const ids = ['routeLatA', 'routeLonA', 'routeLatB', 'routeLonB'];
    if (ids.some(id => !element(id).checkValidity() || element(id).value.trim() === '')) {
      status('Revise as coordenadas: latitude -75° a 75°, longitude -180° a 180°.'); return;
    }
    const [latA, lonA, latB, lonB] = ids.map(id => Number(element(id).value));
    if (!automatic()) {
      for (const [lat, lon] of [[latA, lonA], [latB, lonB]]) {
        const c = api.latLonToCell(grid, lat, lon);
        if (c.x < 0 || c.y < 0 || c.x >= grid.width || c.y >= grid.height
            || !Number.isFinite(grid.elevations[c.y * grid.width + c.x])) {
          status('Esses pontos ficam fora de Gale local. Selecione o modo Automático para buscar outra região.'); return;
        }
      }
    }
    setEndpoint('A', latA, lonA);
    setEndpoint('B', latB, lonB);
    map.fitBounds([endpoints.A.position, endpoints.B.position], { padding: [50, 50], maxZoom: 11 });
  };
  for (const id of ['weightDistance', 'weightSlope', 'weightAscent', 'routeMaxSlope']) {
    element(id).addEventListener('input', () => { clearResult(); status('Parâmetros alterados. Calcule a rota novamente.'); });
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
        coordinateSystem: 'Mars planetocentric latitude / east longitude, degrees',
        elevationReference: grid.source.terrainReference, weights: lastResult.weights,
        distanceM: lastResult.distanceM, ascentM: lastResult.ascentM, descentM: lastResult.descentM,
        maxSlopeDeg: lastResult.maxSlopeDeg, cost: lastResult.cost, costParts: lastResult.costParts,
        limitations: 'Regional prototype; no local obstacle, soil or weather validation.' },
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
  currentMarker.setLatLng([-4.59, 137.44]).setPopupContent('Gale — área de planejamento regional').closePopup();
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
