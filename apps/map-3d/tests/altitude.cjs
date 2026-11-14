const fs = require('fs'), zlib = require('zlib'), vm = require('vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'),'utf8');
const code = html.slice(html.indexOf('    // MOLA MEGDR:'), html.indexOf('    // Filtro box'));
const { sample, build } = vm.runInNewContext('const MOLA_MIN_ELEV_KM=-8.2, MOLA_SPAN_KM=29.4;\n'+code+'\n({sample:sampleMolaMeters,build:buildMolaHeights})');
const payloadContext = {};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../data/mola-16ppd.js'), 'utf8'), payloadContext);
const raw = zlib.gunzipSync(Buffer.from(payloadContext.MOLA_DEM_GZIP_BASE64, 'base64'));
assert.equal(raw.length,5760*2880*2);
const dem = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
const ascraeus = sample(dem,11.87,-104.32);
assert.ok(ascraeus>17000 && ascraeus<19000, 'Ascraeus summit region: '+ascraeus);
assert.ok(Math.abs(ascraeus-sample(dem,11.87,255.68)) < 1e-6);
assert.equal(sample(dem,0,0),sample(dem,0,360));
assert.equal(sample(dem,0,-180),sample(dem,0,180));
assert.equal(sample(dem,89.96875,0.03125),dem.getInt16(0,false));
for(const lat of [-90,90]) assert.ok(Number.isFinite(sample(dem,lat,0)));
const field = build(dem,129,129,{latMin:9.8,latMax:14,lonMin:-106.5,lonMax:-102.3});
let maxStep = 0;
for(let y=0;y<129;y++) for(let x=0;x<129;x++) {
 const i=y*129+x;
 assert.ok(Number.isFinite(field[i]));
 if(x) maxStep=Math.max(maxStep,Math.abs(field[i]-field[i-1])*29.4);
 if(y) maxStep=Math.max(maxStep,Math.abs(field[i]-field[i-129])*29.4);
}
assert.ok(maxStep<2,'No multi-kilometer pixel spikes: '+maxStep);
console.log('PASS: signed meters, pixel centers, longitude wrapping, poles and Ascraeus grid');
console.log({ascraeusMeters:ascraeus,maxAdjacentStepKm:maxStep});



// Exercise the actual asynchronous loader with local-file URLs and no fetch API.
(async () => {
 const context = vm.createContext({ URL, Blob, Response, DecompressionStream, atob });
 let scriptLoads = 0;
 context.document = {
   baseURI: 'file:///C:/project/apps/map-3d/index.html',
   createElement: () => ({ remove() {} }),
   head: { appendChild(script) {
     scriptLoads++;
     assert.equal(script.src, 'file:///C:/project/apps/map-3d/data/mola-16ppd.js');
     context.MOLA_DEM_GZIP_BASE64 = payloadContext.MOLA_DEM_GZIP_BASE64;
     queueMicrotask(() => script.onload());
   } }
 };
 const load = vm.runInContext(code + '\nloadMolaDem', context);
 const first = load();
 assert.equal(first, load(), 'Concurrent loads share one promise');
 const loaded = await first;
 assert.equal(loaded.byteLength, raw.length);
 assert.equal(loaded.getInt16(0, false), dem.getInt16(0, false));
 assert.equal(scriptLoads, 1);
 assert.equal(context.MOLA_DEM_GZIP_BASE64, undefined);
 console.log('PASS: file URL loading, decompression and concurrent requests without fetch');
})().catch(error => { console.error(error); process.exitCode = 1; });
