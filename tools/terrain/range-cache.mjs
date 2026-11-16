import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
export class RangeCache {
  constructor(directory, { maxBytes = 512 * 1024 * 1024, transport } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.transport = transport || curlRange;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.hits = 0; this.misses = 0; this.downloadedBytes = 0;
  }
  async get(url, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
        || end - start > 16 * 1024 * 1024) throw new Error('Invalid read range.');
    const key = createHash('sha256').update(`${url}|${start}|${end}`).digest('hex');
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this.read(key, url, start, end).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  async read(key, url, start, end) {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, key + '.bin');
    try {
      const bytes = await readFile(file);
      if (bytes.length === end - start + 1) { this.hits++; return bytes; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.misses++;
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const bytes = await this.transport(url, start, end);
      if (bytes.length !== end - start + 1) throw new Error('Partial response has an invalid size.');
      this.downloadedBytes += bytes.length;
      await this.prune(bytes.length);
      const temporary = file + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, bytes);
      await rename(temporary, file);
      return bytes;
    } finally { release(); }
  }
  async prune(incoming) {
    const files = await Promise.all((await readdir(this.directory)).filter(name => name.endsWith('.bin')).map(async name => {
      const file = path.join(this.directory, name);
      return { file, ...(await stat(file)) };
    }));
    let size = files.reduce((sum, item) => sum + item.size, 0);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of files) {
      if (size + incoming <= this.maxBytes) break;
      await unlink(entry.file);
      size -= entry.size;
    }
  }
}

async function curlRange(url, start, end) {
  const length = end - start + 1;
  const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const { stdout } = await execute(executable, [
    '--silent', '--show-error', '--fail', '--location', '--retry', '1',
    '--connect-timeout', '15', '--max-time', '90', '--range', `${start}-${end}`,
    '--max-filesize', String(length), '--include', url
  ], { encoding: 'buffer', timeout: 100000, maxBuffer: length + 65536 });
  let offset = 0, headers;
  do {
    const endOfHeaders = stdout.indexOf('\r\n\r\n', offset);
    if (endOfHeaders < 0) throw new Error('Remote server returned no valid HTTP header.');
    headers = stdout.subarray(offset, endOfHeaders).toString('ascii');
    offset = endOfHeaders + 4;
  } while (stdout.subarray(offset, offset + 5).toString('ascii') === 'HTTP/');
  const status = Number(headers.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
  const range = headers.match(/content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/i);
  if (status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== end) {
    throw new Error('The source did not confirm the requested range.');
  }
  return stdout.subarray(offset);
}
