// Browser regression checks using Node 22+ and an isolated Chromium CDP session on port 9222.
// Start Edge/Chrome with --headless --remote-debugging-port=9222 --user-data-dir=<temporary-profile>.
// Run: node apps/map-2d/tests/rendering.cjs
﻿const assert=require('node:assert/strict');
(async()=>{
 const tabs=await(await fetch('http://127.0.0.1:9222/json')).json();
 const ws=new WebSocket(tabs.find(t=>t.type==='page'&&!t.url.startsWith('edge://')).webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 let seq=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);};
 const call=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.error||r.result.exceptionDetails)throw Error(JSON.stringify(r.error||r.result.exceptionDetails));return r.result.result.value;};
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
 await call('Emulation.setDeviceMetricsOverride',{width:1500,height:950,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:require('node:url').pathToFileURL(require('node:path').resolve(__dirname,'../index.html')).href});
 for(let i=0;i<40;i++){if(await evaluate('typeof jumpPreset === "function"'))break;await wait(500);}
 await wait(2500);
 // Keep the layer test's viewport independent of the planner's initial AOI fit.
 await evaluate('map.setView([-4.59,137.44],6,{animate:false});void 0');await wait(500);
 console.log('initial',await evaluate('document.getElementById("layerStatus").innerText'));
 assert.equal(await evaluate('document.getElementById("molaLegend").hidden'),true);
 await evaluate('tesDust.addTo(map);void 0');await wait(2000);
 const dust=await evaluate('({zoom:tesDust._tileZoom,urls:Object.values(tesDust._tiles).map(t=>t.el.src),status:statusState.tesDust})');
 assert.equal(dust.zoom,1);assert.ok(dust.urls.every(url=>url.includes('/1/')));console.log('TES',dust);
 await evaluate('map.removeLayer(vikingColor);map.removeLayer(jezeroHiRise);map.removeLayer(tesDust);molaColor.addTo(map);document.getElementById("colorModeSelect").value="thermal-false";applyColorMode();');
 await wait(2000);
 assert.equal(await evaluate('Object.keys(statusState).join(",")'),'molaColor');
 assert.equal(await evaluate('document.getElementById("molaLegend").hidden'),false);
 assert.equal(await evaluate('getComputedStyle(molaColor.getContainer()).filter'),'none');
 assert.equal(await evaluate('getComputedStyle(map.getPane("tilePane")).filter'),'none');
 // Simulate a failed visible tile, then the fallback load event that formerly hid it.
 const partial=await evaluate(`(()=>{const t=Object.values(molaColor._tiles).find(t=>map.getBounds().contains(map.unproject([(t.coords.x+0.5)*256,(t.coords.y+0.5)*256],t.coords.z)));molaColor.fire('tileerror',{tile:t.el,coords:t.coords});molaColor.fire('tileload',{tile:t.el,coords:t.coords});return statusState.molaColor;})()`);
 assert.ok(partial.includes('⚠️'));console.log('partial',partial);
 // Force an actual network failure, then recover.
 await call('Network.setBlockedURLs',{urls:['*Mars_MGS_MOLA_ClrShade_merge_global_463m*']});
 await evaluate('molaColor.redraw();void 0');await wait(2000);
 const failure=await evaluate('statusState.molaColor');assert.ok(failure.includes('Falha'));console.log('blocked network',failure);
 await call('Network.setBlockedURLs',{urls:[]});await evaluate('molaColor.redraw();void 0');
 for(let n=0;n<60;n++){if((await evaluate('statusState.molaColor')).includes('?'))break;await wait(500);}
 console.log('recovery',await evaluate('statusState.molaColor'));
 assert.ok((await evaluate('statusState.molaColor')).includes('✅'));
 await evaluate('map.removeLayer(molaColor);vikingColor.addTo(map);void 0');await wait(1200);
 assert.equal(await evaluate('document.getElementById("molaLegend").hidden'),true);
 assert.ok((await evaluate('getComputedStyle(vikingColor.getContainer()).filter')).includes('sepia'));
 assert.equal(await evaluate('Object.keys(statusState).join(",")'),'vikingColor');
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('PASS: file opening, TES native zoom, partial/total failures, recovery, active-only status, palette protection and optical filters');
 ws.close();
})().catch(error=>{console.error(error);process.exit(1)});
