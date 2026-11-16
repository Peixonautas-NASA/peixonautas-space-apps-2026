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
    await call('Page.navigate', { url: process.argv[2] || pathToFileURL(path.resolve(__dirname, '../index.html')).href });
    await waitUntil('document.getElementById("routeStatus")?.textContent.includes("Route calculated")');
    // Remain deterministic when testing through the terrain service.
    await evaluate(`{const el=document.getElementById('terrainMode');el.value='local';el.dispatchEvent(new Event('change'));}`);
    await evaluate(`document.getElementById('environmentRadiationWeight').value='2';document.getElementById('calculateRoute').click();`);
    assert.match(await evaluate(`document.getElementById('routeStatus').textContent`), /scenario or grid/);
    assert.equal(await evaluate(`document.getElementById('exportRoute').disabled`), true);
    await evaluate(`{
      for(const f of ['Radiation','Temperature','Magnetism']) {
        document.getElementById('environment'+f+'Mode').value='uniform';
        document.getElementById('environment'+f+'Weight').value='2';
      }
      document.getElementById('environmentTemperatureValue').value='-100';
      document.getElementById('environmentMagnetismValue').value='5000';
      document.getElementById('calculateRoute').click();
    }`);
    await waitUntil('document.getElementById("routeStatus").textContent.includes("Route calculated")');
    const metrics = await evaluate(`document.getElementById('routeMetrics').textContent`);
    assert.match(metrics, /estimated model\/scenario dose/); assert.match(metrics, /maximum sampled field/); assert.match(metrics, /constant speed/);
    await evaluate(`{
      globalThis.environmentExports=[];
      const original=URL.createObjectURL;
      URL.createObjectURL=function(blob){if(blob.type!=='text/javascript')environmentExports.push(blob.text());return original.call(URL,blob)};
      HTMLAnchorElement.prototype.click=function(){};
      document.getElementById('exportRoute').click();
    }`);
    const exported = await evaluate(`Promise.all(environmentExports).then(xs=>JSON.parse(xs[0]))`);
    assert.equal(exported.properties.environmentInput.weights.radiation, 2);
    assert.equal(exported.properties.environment.layers.radiation.source.kind, 'scenario');
    assert.ok(exported.properties.environment.doseUSv > 0);
    for (const field of ['radiation','temperature','magnetism']) assert.ok(exported.properties.costParts[field] > 0);
    await evaluate(`document.getElementById('environmentRadiationDemo').click();document.getElementById('exportEnvironment').click();`);
    assert.match(await evaluate(`document.getElementById('environmentRadiationInfo').textContent`), /SYNTHETIC/);
    const config = await evaluate(`Promise.all(environmentExports).then(xs=>JSON.parse(xs[1]))`);
    assert.equal(config.settings.layers.radiation.raster.source.kind, 'scenario');
    const importFile = async (id, data) => evaluate(`{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(data))}], 'test.json',{type:'application/json'}));const el=document.getElementById(${JSON.stringify(id)});el.files=dt.files;el.dispatchEvent(new Event('change'));}`);
    await evaluate(`document.getElementById('resetEnvironment').click()`);
    await importFile('importEnvironment', config);
    await waitUntil(`document.getElementById('environmentStatus').textContent.includes('grids imported')`);
    assert.equal(await evaluate(`document.getElementById('environmentRadiationWeight').value`), '2');
    const invalid = structuredClone(config.settings.layers.radiation.raster); invalid.unit='Gy';
    await importFile('environmentRadiationFile', invalid);
    await waitUntil(`document.getElementById('environmentStatus').textContent.includes('rejected')`);
    assert.equal(await evaluate(`document.getElementById('environmentRadiationMode').value`), 'raster');
    await evaluate(`document.getElementById('calculateRoute').click()`);
    await waitUntil('document.getElementById("routeStatus").textContent.includes("Route calculated")');
    assert.match(await evaluate(`document.getElementById('routeMetrics').textContent`), /SYNTHETIC EXAMPLE/);
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    console.log('PASS: environmental worker costs, scenario provenance, synthetic raster, export, config roundtrip and atomic rejection');
  } finally { socket.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
