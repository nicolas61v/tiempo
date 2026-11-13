import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { openStore, AppError } from './store.js';
import { createPush } from './push.js';
import { createJudge } from './judge.js';
import { loadStatic, serveStatic } from './static.js';

const log = {
  info: (...a) => console.log('[tiempo]', ...a),
  warn: (...a) => console.warn('[tiempo]', ...a),
  error: (...a) => console.error('[tiempo]', ...a),
};

if (config.onRailway && !config.hasVolume) {
  log.warn('⚠ Sin volumen: la base se borra en cada deploy. Agrega un volumen al servicio (mount path /data).');
}

const store = openStore({ dir: config.dataDir, initialSeconds: config.initialSeconds, minWage: config.minWage });
const push = createPush(store, { ...config.vapid, log });
const judge = createJudge({ log });
if (!judge.enabled) log.warn('⚠ Guardián apagado: define ANTHROPIC_API_KEY para activar "Mi día".');

// Mantenimiento: devuelve códigos no reclamados y cierra días abandonados.
setInterval(() => {
  try {
    store.expireTransfers();
    store.purgeDays();
  } catch (err) {
    log.error('mantenimiento:', err);
  }
}, 15_000).unref();
const site = loadStatic(path.join(config.root, 'public'), {
  __INITIAL__: String(config.initialSeconds),
  __MIN_WAGE__: String(config.minWage),
});

const SECURITY = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()', // micrófono: dictado en "Mi día"
  ...(config.onRailway && { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
};

/* ───────── utilidades HTTP ───────── */

function send(res, status, data) {
  if (data === undefined) {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(new AppError(413, 'too_big', 'Petición demasiado grande'));
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new AppError(400, 'json', 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (key) => {
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n <= max;
  };
}
const limitSessions = limiter(20, 3_600_000);
const limitApi = limiter(240, 60_000);
const limitClaims = limiter(10, 60_000); // contra adivinar códigos

function fmtSeconds(s) {
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).slice(0, 2).join(' ') || `${s}s`;
}

/** Pide veredicto a la IA; si falla, el último mensaje se retira para poder reintentar. */
async function runJudge(id, dayId) {
  try {
    store.saveVerdict(dayId, await judge.evaluate(store.judgeInput(id, dayId)));
  } catch (err) {
    store.rollbackDay(dayId);
    throw err;
  }
  return { day: store.publicDay(id, dayId) };
}

function requireJudge() {
  if (!judge.enabled) throw new AppError(503, 'judge_off', 'El Guardián no está configurado: falta ANTHROPIC_API_KEY.');
}

/* ───────── API ───────── */

async function api(req, res, p) {
  const m = req.method;

  if (m === 'POST' && p === '/api/session') {
    if (!limitSessions(clientIp(req))) throw new AppError(429, 'rate', 'Demasiados intentos, espera un rato');
    return send(res, 201, store.createUser());
  }
  if (m === 'GET' && p === '/api/push/key') return send(res, 200, { publicKey: push.publicKey });

  const user = store.auth(bearer(req));
  if (!user) throw new AppError(401, 'auth', 'Llave inválida');
  if (!limitApi(user.id)) throw new AppError(429, 'rate', 'Más despacio');
  const id = user.id;

  if (m === 'GET' && p === '/api/state') return send(res, 200, store.state(id));

  if (m === 'POST' && p === '/api/tx') {
    const b = await readJson(req);
    return send(res, 201, store.addTx(id, { category: b.category, amount: b.amount, note: b.note }));
  }

  const undo = /^\/api\/tx\/(\d+)$/.exec(p);
  if (m === 'DELETE' && undo) return send(res, 200, store.undoTx(id, Number(undo[1])));

  if (m === 'POST' && p === '/api/rebirth') {
    const b = await readJson(req);
    return send(res, 200, store.rebirth(id, b.force === true));
  }

  // Mi día: contar → veredicto → hasta 2 réplicas → aceptar o descartar
  if (m === 'POST' && p === '/api/day') {
    requireJudge();
    const b = await readJson(req, 6_000_000);
    const { id: dayId } = store.openDay(id, b);
    return send(res, 201, await runJudge(id, dayId));
  }
  const day = /^\/api\/day\/(\d+)\/(reply|accept|discard)$/.exec(p);
  if (m === 'POST' && day) {
    const dayId = Number(day[1]);
    if (day[2] === 'reply') {
      requireJudge();
      store.replyDay(id, dayId, await readJson(req, 6_000_000));
      return send(res, 200, await runJudge(id, dayId));
    }
    if (day[2] === 'accept') return send(res, 200, store.acceptDay(id, dayId));
    store.discardDay(id, dayId);
    return send(res, 204);
  }

  // Transferencias de tiempo
  if (m === 'POST' && p === '/api/transfer') {
    const b = await readJson(req);
    return send(res, 201, store.createTransfer(id, b.seconds));
  }
  if (m === 'POST' && p === '/api/transfer/claim') {
    if (!limitClaims(id)) throw new AppError(429, 'rate', 'Demasiados intentos, espera un minuto');
    const b = await readJson(req);
    const r = store.claimTransfer(id, b.code);
    push
      .sendToUser(r.fromUser, { title: 'Tiempo entregado', body: `Alguien recibió ${fmtSeconds(r.seconds)} de tu tiempo.` })
      .catch(() => {});
    return send(res, 200, { seconds: r.seconds, state: r.state });
  }
  const transfer = /^\/api\/transfer\/([A-Za-z0-9]{6})$/.exec(p);
  if (transfer && m === 'GET') return send(res, 200, store.transferStatus(id, transfer[1]));
  if (transfer && m === 'DELETE') return send(res, 200, store.cancelTransfer(id, transfer[1]));

  if (p === '/api/push' && (m === 'POST' || m === 'DELETE')) {
    const b = await readJson(req);
    if (m === 'POST') store.addSub(id, b);
    else store.removeSub(id, b.endpoint);
    return send(res, 204);
  }

  throw new AppError(404, 'not_found', 'Ruta desconocida');
}

/* ───────── servidor ───────── */

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const p = new URL(req.url, 'http://local').pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, version: site.version });
    if (p.startsWith('/api/')) return await api(req, res, p);
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, site, p)) return;
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof AppError) return send(res, err.status, { error: err.code, message: err.message });
    log.error(err);
    if (!res.headersSent) send(res, 500, { error: 'server', message: 'Algo falló en el servidor' });
  }
});

server.keepAliveTimeout = 65_000; // mayor que el del proxy de Railway

server.listen(config.port, () => {
  log.info(`listo en :${config.port} · v${site.version} · datos en ${config.dataDir} · inicio ${config.initialSeconds}s`);
});

function shutdown(signal) {
  log.info(`${signal}: cerrando`);
  push.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
