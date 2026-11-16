import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { CATALOG } from './catalog.mjs';
import { RangeCache } from './range-cache.mjs';
import { TerrainService, LIMITS } from './terrain-service.mjs';

export function createTerrainServer({ root = fileURLToPath(new URL('../../', import.meta.url)), service } = {}) {
  const cache = service?.cache || new RangeCache(path.join(root, '.terrain-cache'));
  const terrain = service || new TerrainService(cache);
  function json(request, response, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (body.length > 4096 && request.headers['accept-encoding']?.includes('gzip')) {
      response.setHeader('Content-Encoding', 'gzip');
      response.writeHead(status).end(gzipSync(body));
    } else response.writeHead(status).end(body);
  }
  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      const parsedHost = new URL('http://' + host);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedHost.hostname)) {
        response.writeHead(403).end('Local host only'); return;
      }
      if (request.headers.origin && request.headers.origin !== 'http://' + host) {
        response.writeHead(403).end('Same origin only'); return;
      }
      const url = new URL(request.url, 'http://' + host);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(request, response, 200, { service: 'peixonautas-terrain', version: 1, limits: LIMITS }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/catalog') {
        json(request, response, 200, { sources: CATALOG, limits: LIMITS }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/terrain') {
        if (!request.headers['content-type']?.startsWith('application/json')) {
          json(request, response, 415, { error: 'Use application/json.' }); return;
        }
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 4096) { json(request, response, 413, { error: 'Request too large.' }); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { json(request, response, 400, { error: 'Invalid JSON.' }); return; }
        const result = await terrain.getTerrain(input);
        if (!response.destroyed) json(request, response, 200, result);
        return;
      }
      if (url.pathname.startsWith('/api/')) { json(request, response, 404, { error: 'Unknown endpoint.' }); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      let relative = decodeURIComponent(url.pathname);
      if (relative === '/') { response.writeHead(302, { Location: '/apps/map-2d/index.html' }).end(); return; }
      const allowed = ['/apps/map-2d/', '/packages/shared/navigation/', '/data/gale/'];
      if (!allowed.some(prefix => relative.startsWith(prefix)) || relative.split('/').some(part => part.startsWith('.'))) {
        response.writeHead(403).end(); return;
      }
      const file = path.resolve(root, '.' + relative);
      const resolved = await realpath(file);
      if (!resolved.startsWith(path.resolve(root) + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
      const type = types[path.extname(file)];
      if (!type) { response.writeHead(403).end(); return; }
      const body = await readFile(resolved);
      response.setHeader('Content-Type', type);
      response.setHeader('Cache-Control', 'no-cache');
      response.writeHead(200).end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const status = error.code === 'ENOENT' ? 404 : error.status || 500;
      json(request, response, status, { error: status === 500 ? 'Internal error preparing terrain.' : error.message });
    }
  });
  server.requestTimeout = 300000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TERRAIN_PORT || 7878);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid TERRAIN_PORT.');
  const server = createTerrainServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Terrain service: http://127.0.0.1:${port}/`));
}
