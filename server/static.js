import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;
const TEMPLATED = new Set(['/index.html', '/sw.js']);

/**
 * Carga /public en memoria una sola vez, ya comprimido (brotli + gzip).
 * La versión es un hash del contenido: cambia sola en cada deploy y renueva el service worker.
 */
export function loadStatic(dir, vars = {}) {
  const files = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.set('/' + path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p));
    }
  };
  walk(dir);

  const hash = createHash('sha256');
  for (const [url, buf] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(url).update(buf);
  for (const v of Object.values(vars)) hash.update(String(v));
  const version = hash.digest('hex').slice(0, 10);
  const replacements = { __VERSION__: version, ...vars };

  const assets = new Map();
  for (let [url, buf] of files) {
    if (TEMPLATED.has(url)) {
      let text = buf.toString('utf8');
      for (const [k, v] of Object.entries(replacements)) text = text.replaceAll(k, v);
      buf = Buffer.from(text);
    }
    const type = TYPES[path.extname(url)] || 'application/octet-stream';
    const asset = {
      buf,
      type,
      etag: `"${createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"`,
      cache: /^\/(icons|fonts)\//.test(url) ? 'public, max-age=604800' : 'no-cache',
    };
    if (COMPRESSIBLE.test(type) && buf.length > 512) {
      asset.br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
      asset.gz = zlib.gzipSync(buf, { level: 9 });
    }
    assets.set(url, asset);
  }
  return { version, assets };
}

export function serveStatic(req, res, site, pathname) {
  let asset = site.assets.get(pathname === '/' ? '/index.html' : pathname);
  if (!asset && !path.extname(pathname)) asset = site.assets.get('/index.html'); // rutas de la app
  if (!asset) return false;

  const headers = { 'Content-Type': asset.type, 'Cache-Control': asset.cache, ETag: asset.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const accept = req.headers['accept-encoding'] || '';
  let body = asset.buf;
  if (asset.br && /\bbr\b/.test(accept)) {
    body = asset.br;
    headers['Content-Encoding'] = 'br';
  } else if (asset.gz && /\bgzip\b/.test(accept)) {
    body = asset.gz;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
