// Requires an isolated Edge/Chrome CDP session on localhost:9222 (see rendering.cjs).
// Optional argument: HTTP URL of apps/map-2d/index.html. Default: direct file://.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
  const target = tabs.find(tab => tab.type === 'page' && !tab.url.startsWith('edge://'));
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => { socket.onopen = resolve; });
  let sequence = 0;
  const pending = new Map(), exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  };
  const call = (method, params = {}) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error || reply.result.exceptionDetails));
    return reply.result.result.value;
  };
  const waitUntil = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out: ' + expression + '; status=' + await evaluate('document.getElementById("routeStatus").textContent'));
  };
  try {
    await call('Runtime.enable');
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    const url = process.argv[2] || pathToFileURL(path.resolve(__dirname, '../index.html')).href;
    await call('Page.navigate', { url });
    await waitUntil('document.getElementById("routeStatus")?.textContent.includes("Rota calculada")');
    const initialMetrics = await evaluate('document.getElementById("routeMetrics").textContent');
    assert.ok(initialMetrics.includes('5,9 km'), initialMetrics);
    assert.equal(await evaluate('document.getElementById("exportRoute").disabled'), false);
    assert.equal(await evaluate('map.getCenter().lat < -4 && map.getCenter().lng > 137'), true);

    // A weight edit immediately invalidates old geometry/metrics; a new worker recalculates.
    await evaluate('document.getElementById("weightSlope").value="30";document.getElementById("weightSlope").dispatchEvent(new Event("input"));');
    assert.equal(await evaluate('document.getElementById("routeMetrics").textContent'), '');
    assert.equal(await evaluate('document.getElementById("exportRoute").disabled'), true);
    await evaluate('document.getElementById("calculateRoute").click()');
    await waitUntil('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    assert.notEqual(await evaluate('document.getElementById("routeMetrics").textContent'), initialMetrics);

    // Cancel an in-flight request with an edit; its reply must not restore the old path.
    await evaluate('document.getElementById("calculateRoute").click();document.getElementById("weightSlope").value="3";document.getElementById("weightSlope").dispatchEvent(new Event("input"));');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await evaluate('document.getElementById("routeMetrics").textContent'), '');

    // Invalid values produce actionable feedback and no stale export.
    await evaluate('document.getElementById("weightDistance").value="0";document.getElementById("calculateRoute").click()');
    assert.ok((await evaluate('document.getElementById("routeStatus").textContent')).includes('Revise'));
    await evaluate('document.getElementById("weightDistance").value="1"');

    // Map selection snaps both endpoints to the same real cell and returns zero distance.
    await evaluate('document.getElementById("selectRouteB").click();map.fire("click",{latlng:L.latLng(-4.59,137.44)});document.getElementById("calculateRoute").click();');
    await waitUntil('document.getElementById("routeStatus").textContent.includes("mesma célula")');
    assert.ok((await evaluate('document.getElementById("routeMetrics").textContent')).includes('0 km'));

    // Clicking outside the study area must not silently clamp or move the endpoint.
    const endpoints = await evaluate('document.getElementById("routeEndpoints").textContent');
    await evaluate('document.getElementById("selectRouteB").click();map.fire("click",{latlng:L.latLng(0,0)});void 0;');
    assert.equal(await evaluate('document.getElementById("routeEndpoints").textContent'), endpoints);
    assert.ok((await evaluate('document.getElementById("routeStatus").textContent')).includes('área de interesse'));
    await evaluate('document.getElementById("selectRouteB").click()');

    // Restore the example route, then inspect the exported object without downloading.
    await evaluate('document.getElementById("selectRouteB").click();map.fire("click",{latlng:L.latLng(-4.68,137.42)});document.getElementById("calculateRoute").click();');
    await waitUntil('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    const exported = await evaluate(`(async () => {
      const originalURL = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
      let payload;
      URL.createObjectURL = blob => { payload = blob; return 'blob:route-test'; };
      HTMLAnchorElement.prototype.click = function () {};
      try { document.getElementById('exportRoute').click(); return JSON.parse(await payload.text()); }
      finally { URL.createObjectURL = originalURL; HTMLAnchorElement.prototype.click = originalClick; }
    })()`);
    assert.equal(exported.geometry.type, 'LineString');
    assert.equal(exported.properties.sourceDoi, '10.5281/zenodo.5808354');
    assert.equal(exported.properties.resolutionM, 30);
    assert.ok(exported.geometry.coordinates.every(([lon, lat, z]) => lon > 137 && lon < 138 && lat < -4 && lat > -5 && z < 0));
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    assert.equal(await evaluate('map.getBounds().contains(L.latLng(-4.59,137.44)) && map.getBounds().contains(L.latLng(-4.68,137.42))'), true);
    console.log('PASS: ' + url + ': real-data worker, weights, cancellation, point selection, invalid inputs and planetary export');
    console.log(initialMetrics);
    if (process.env.GALE_SCREENSHOT) {
      const screenshot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.GALE_SCREENSHOT, Buffer.from(screenshot.result.data, 'base64'));
    }
  } finally { socket.close(); }
})().catch(error => { console.error(error); process.exit(1); });
