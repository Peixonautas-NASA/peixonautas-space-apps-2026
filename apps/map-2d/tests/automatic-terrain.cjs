// Run with tools/terrain/server.mjs and an isolated Chromium CDP session on :9222.
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
  const tab = tabs.find(t => t.type === 'page' && !t.url.startsWith('edge://'));
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  let sequence = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
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
    for (let i = 0; i < 1200; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out; status=' + await evaluate('document.getElementById("routeStatus").textContent'));
  };
  const coordinates = async (a, b) => evaluate(`
    document.getElementById('routeLatA').value=${a[0]};document.getElementById('routeLonA').value=${a[1]};
    document.getElementById('routeLatB').value=${b[0]};document.getElementById('routeLonB').value=${b[1]};
    document.getElementById('applyRouteCoordinates').click();document.getElementById('calculateRoute').click();
  `);
  try {
    await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: 'http://127.0.0.1:7878/' });
    await waitFor('document.getElementById("routeStatus")?.textContent.includes("Rota calculada")');
    assert.equal(await evaluate('document.getElementById("terrainMode").value'), 'auto');
    assert.ok((await evaluate('document.getElementById("terrainSourceInfo").textContent')).includes('30 m'));
    await coordinates([-4.59, 137.44], [-4.85, 137.44]);
    await waitFor('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    assert.ok((await evaluate('document.getElementById("routeMetrics").textContent')).includes('17,5 km'));
    console.log('PASS: Gale beyond the original crop, real 30m HRSC and ~17.5 km route');
    await evaluate('document.getElementById("calculateRoute").click()');
    await waitFor('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    assert.ok((await evaluate('document.getElementById("terrainSourceInfo").textContent')).includes('cache'));

    // Controlled unavailable-corridor fixtures exercise real worker + automatic expansion.
    await evaluate(`(async () => {
      const response = await fetch('/api/terrain',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({start:{lat:-4.59,lon:137.44},goal:{lat:-4.85,lon:137.44}})});
      window.testTerrain = await response.json(); window.testExpansions = []; window.originalFetch = window.fetch;
      window.fetch = async function(url, options) {
        if(url !== '/api/terrain') return window.originalFetch(url, options);
        const query = JSON.parse(options.body), data = structuredClone(window.testTerrain);
        window.testExpansions.push(query.expansion);
        if(query.expansion < 2) {
          const a = PeixonautasNavigation.latLonToCell(data,-4.59,137.44);
          const b = PeixonautasNavigation.latLonToCell(data,-4.85,137.44);
          const barrier = Math.floor((a.y+b.y)/2);
          for(let x=0;x<data.width;x++) data.elevations[barrier*data.width+x]=null;
        }
        return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
      };
      document.getElementById('calculateRoute').click();
    })()`);
    await waitFor('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    assert.deepEqual(await evaluate('window.testExpansions'), [0, 1, 2]);
    await evaluate('window.fetch=window.originalFetch;delete window.testTerrain;void 0');
    console.log('PASS: NoData barrier triggers attempts 0, 1 and 2; old paths are not reused');

    await coordinates([18.65, -133.8], [18.67, -133.78]);
    await waitFor('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    const source = await evaluate('document.getElementById("terrainSourceInfo").textContent');
    assert.ok(source.includes('MOLA') && source.includes('463 m'), source);
    assert.ok((await evaluate('document.getElementById("routeStatus").textContent')).includes('Rota regional'));
    console.log('PASS: real Olympus MOLA, resolution disclosure and regional limitation');

    // Export carries the actual provider/selection rather than the old Gale metadata.
    const exported = await evaluate(`(async()=>{
      const make=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let payload;
      URL.createObjectURL=b=>{payload=b;return 'blob:test'};HTMLAnchorElement.prototype.click=function(){};
      try{document.getElementById('exportRoute').click();return JSON.parse(await payload.text());}
      finally{URL.createObjectURL=make;HTMLAnchorElement.prototype.click=click;}
    })()`);
    assert.ok(exported.properties.sourceUrl.includes('/meg128/'));
    assert.ok(exported.properties.resolutionM > 460);
    assert.equal(exported.properties.terrainSelection.localDetailAvailable, false);
    assert.ok(exported.geometry.coordinates.every(([lon, lat, z]) => lon < -133 && lat > 18 && z > 19000));

    await coordinates([0, 20], [12, 32]);
    await waitFor('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    const coarseSource = await evaluate('document.getElementById("terrainSourceInfo").textContent');
    assert.ok(coarseSource.includes('16 px') && coarseSource.includes('3.704'), coarseSource);
    console.log('PASS: ~1000 km itinerary uses native MOLA 16ppd and discloses the coarser grid');

    // Unsupported coordinates return a visible error and invalidate the old export.
    await coordinates([0, 179], [0, -179]);
    await waitFor('document.getElementById("routeStatus").textContent.includes("antimeridiano")');
    assert.equal(await evaluate('document.getElementById("exportRoute").disabled'), true);
    assert.equal(await evaluate('document.getElementById("routeMetrics").textContent'), '');
    await evaluate('document.getElementById("terrainMode").value="local";document.getElementById("terrainMode").dispatchEvent(new Event("change"));');
    await coordinates([-4.59, 137.44], [-4.68, 137.42]);
    await waitFor('document.getElementById("routeStatus").textContent.includes("Rota calculada")');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log('PASS: planetary export, explicit unsupported-region error and return to local Gale');
    if (process.env.TERRAIN_SCREENSHOT) {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.TERRAIN_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
    }
  } finally { ws.close(); }
})().catch(error => { console.error(error); process.exit(1); });
