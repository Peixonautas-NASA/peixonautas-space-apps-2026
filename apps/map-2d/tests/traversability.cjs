// Requires an isolated Chromium CDP profile on :9222. Uses bundled Gale/file://.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const nav = require('../../../packages/shared/navigation/planner.js');
const context = {};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../data/gale/terrain.js'), 'utf8'), context);
const data = context.GALE_TERRAIN_DATA;
const grid = { ...data, elevations: Float32Array.from(data.elevations) };

(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page' && !t.url.startsWith('edge://')).webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  let sequence = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  };
  const call = (method, params = {}) => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error || reply.result.exceptionDetails));
    return reply.result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out: ' + expression + ' | ' + await evaluate('document.getElementById("routeStatus").textContent'));
  };
  const calculate = async () => {
    await evaluate('document.getElementById("calculateRoute").click()');
    await waitFor('document.getElementById("routeStatus").textContent.includes("Route calculated")');
  };
  const change = (id, value, checked = false) => evaluate(`document.getElementById('${id}').${checked ? 'checked' : 'value'}=${JSON.stringify(value)};document.getElementById('${id}').dispatchEvent(new Event('input'));`);
  const capture = id => evaluate(`(async()=>{
    const make=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let payload;
    URL.createObjectURL=b=>{payload=b;return 'blob:test'};HTMLAnchorElement.prototype.click=function(){};
    try{document.getElementById('${id}').click();return JSON.parse(await payload.text());}
    finally{URL.createObjectURL=make;HTMLAnchorElement.prototype.click=click;}
  })()`);
  const draw = async (type, ring) => {
    await evaluate(`document.getElementById('annotationType').value=${JSON.stringify(type)};document.getElementById('drawAnnotation').click();
      for(const [lon,lat] of ${JSON.stringify(ring)}) map.fire('click',{latlng:L.latLng(lat,lon)});
      document.getElementById('finishAnnotation').click();`);
  };
  const assertAvoids = route => {
    const snapshot = route.properties.manualTraversability;
    const raster = nav.rasterizeAnnotations(grid, snapshot.areas, snapshot.policy);
    for (const [lon, lat] of route.geometry.coordinates) {
      const c = nav.latLonToCell(grid, lat, lon);
      assert.equal(raster.blocked[c.y * grid.width + c.x], 0);
    }
  };
  const importCollection = collection => evaluate(`(()=>{
    const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(collection))}],'areas.geojson',{type:'application/geo+json'}));
    const input=document.getElementById('importAnnotations');input.files=transfer.files;input.dispatchEvent(new Event('change'));
  })()`);
  try {
    await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: process.argv[2] || require('node:url').pathToFileURL(path.resolve(__dirname, '../index.html')).href });
    await waitFor('document.getElementById("routeStatus")?.textContent.includes("Route calculated")');
    await evaluate('localStorage.removeItem("peixonautas.mars.traversability.v1");location.reload();');
    await waitFor('document.getElementById("routeStatus")?.textContent.includes("Route calculated")');
    const baseline = await capture('exportRoute');
    assert.equal(baseline.properties.traversability.enabled, false);
    const midpoint = baseline.geometry.coordinates[Math.floor(baseline.geometry.coordinates.length / 2)];
    const [lon, lat] = midpoint;
    await draw('blocked', [[lon - .004, lat - .004], [lon + .004, lat - .004], [lon + .004, lat + .004], [lon - .004, lat + .004]]);
    assert.equal(await evaluate('document.querySelectorAll("#annotationList li").length'), 1);
    assert.equal(await evaluate('document.getElementById("exportRoute").disabled'), true);
    await calculate();
    assert.equal((await capture('exportRoute')).properties.cost, baseline.properties.cost);
    await change('useTraversability', true, true); await change('unknownPolicy', 'allow');
    await calculate();
    const blockedRoute = await capture('exportRoute');
    assertAvoids(blockedRoute);
    assert.notDeepEqual(blockedRoute.geometry.coordinates, baseline.geometry.coordinates);
    console.log('PASS: manual drawing, opt-in, per-cell blocked detour and export provenance');

    await evaluate('{const type=document.querySelector("#annotationList select");type.value="difficult";type.dispatchEvent(new Event("change"));}');
    await change('difficultCost', 100); await change('weightTerrain', 0); await calculate();
    assert.equal((await capture('exportRoute')).properties.cost, baseline.properties.cost);
    await change('weightTerrain', 1); await calculate();
    assert.notDeepEqual((await capture('exportRoute')).geometry.coordinates, baseline.geometry.coordinates);
    await evaluate('{const type=document.querySelector("#annotationList select");type.value="blocked";type.dispatchEvent(new Event("change"));}');
    await change('weightTerrain', 0); await calculate(); assertAvoids(await capture('exportRoute'));
    console.log('PASS: difficult costs change paths; zero terrain weight never disables hard blocks');

    await change('unknownPolicy', 'block');
    await evaluate('document.getElementById("calculateRoute").click()');
    await waitFor('document.getElementById("routeStatus").textContent.includes("One endpoint")');
    assert.equal(await evaluate('document.getElementById("exportRoute").disabled'), true);
    const b = data.bounds;
    await draw('normal', [[b.lonMin - .001, b.latMin - .001], [b.lonMax + .001, b.latMin - .001], [b.lonMax + .001, b.latMax + .001], [b.lonMin - .001, b.latMax + .001]]);
    await calculate(); assertAvoids(await capture('exportRoute'));
    const exportedAreas = await capture('exportAnnotations');
    assert.equal(exportedAreas.planet, 'Mars'); assert.equal(exportedAreas.features.length, 2);
    assert.equal(exportedAreas.properties.terrainWeight, 0);
    assert.ok(exportedAreas.features.every(f => f.properties.provenance === 'manual-interpretation'));
    await call('Page.reload');
    await waitFor('document.getElementById("routeStatus")?.textContent.includes("Route calculated")');
    assert.equal(await evaluate('document.querySelectorAll("#annotationList li").length'), 2);
    assert.equal(await evaluate('document.getElementById("useTraversability").checked'), true);
    assert.equal(await evaluate('document.getElementById("weightTerrain").value'), '0');
    assertAvoids(await capture('exportRoute'));
    console.log('PASS: unknown blocking, normal classification and browser persistence after reload');

    await evaluate('document.querySelector("#annotationList button[data-action=remove]").click()');
    assert.equal(await evaluate('document.getElementById("exportRoute").disabled'), true);
    await calculate(); assert.equal((await capture('exportRoute')).properties.cost, baseline.properties.cost);
    await importCollection(exportedAreas);
    await waitFor('document.getElementById("annotationStatus").textContent.includes("imported")');
    assert.equal(await evaluate('document.querySelectorAll("#annotationList li").length'), 2);
    await importCollection({ ...exportedAreas, planet: 'Earth' });
    await waitFor('document.getElementById("annotationStatus").textContent.includes("rejected")');
    assert.equal(await evaluate('document.querySelectorAll("#annotationList li").length'), 2);
    const bad = structuredClone(exportedAreas); bad.features[0].geometry.coordinates = [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]];
    await importCollection(bad);
    await waitFor('document.getElementById("annotationStatus").textContent.includes("intersect")');
    assert.equal(await evaluate('document.querySelectorAll("#annotationList li").length'), 2);
    await evaluate('document.getElementById("drawAnnotation").click();document.getElementById("selectRouteA").click();');
    assert.equal(await evaluate('document.getElementById("drawAnnotation").getAttribute("aria-pressed")'), 'false');
    await evaluate('document.getElementById("selectRouteA").click()');
    await calculate(); assertAvoids(await capture('exportRoute'));
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log('PASS: deletion, atomic import, rejection of Earth/invalid geometry and drawing/point mode coordination');
    if (process.env.MANUAL_SCREENSHOT) {
      await evaluate('document.getElementById("traversabilityEditor").open=true');
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.MANUAL_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
    }
  } finally {
    await evaluate('localStorage.removeItem("peixonautas.mars.traversability.v1")').catch(() => {});
    ws.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
