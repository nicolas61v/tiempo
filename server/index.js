import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { openStore, AppError, DAYS_PER_DAY, cleanLang } from './store.js';
import { createPush, trialFor, deliveredFor } from './push.js';
import { createJudge } from './judge.js';
import { createPayments, PRODUCTS, CURRENCY } from './payments.js';
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
if (store.backupFile) log.info(`copia de seguridad antes de migrar: ${store.backupFile}`);
const push = createPush(store, { ...config.vapid, log });
const judge = createJudge({ log });
if (!judge.enabled) log.warn('⚠ Guardián apagado: define ANTHROPIC_API_KEY para activar "Mi día".');
if (!config.adminToken) log.warn('⚠ Panel /admin apagado: define ADMIN_TOKEN para activarlo.');
const payments = createPayments({ ...config.stripe, log });
if (!payments.enabled) log.warn('⚠ Tienda apagada: define STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET para cobrar.');
else if (!payments.webhookReady) log.warn('⚠ Falta STRIPE_WEBHOOK_SECRET: los pagos solo se confirman cuando la persona vuelve a la app.');
else log.info(`pagos con Stripe listos${payments.testMode ? ' (modo de prueba)' : ' (modo real)'}`);

// Mantenimiento: devuelve códigos no reclamados, cierra días abandonados y juicios vencidos.
setInterval(() => {
  try {
    store.expireTransfers();
    store.purgeDays();
    for (const v of store.closeTrials()) {
      log.info(`juicio #${v.trialId}: ${v.verdict}${v.penalty ? ` (−${v.penalty}s)` : ''}`);
      push.sendToUser(v.userId, { ...trialFor(v.verdict, v.lang), kind: 'trial' }).catch(() => {});
    }
  } catch (err) {
    log.error('mantenimiento:', err);
  }
}, 15_000).unref();
const site = loadStatic(path.join(config.root, 'public'), {
  __INITIAL__: String(config.initialSeconds),
  __MIN_WAGE__: String(config.minWage),
  __DAYS_PER_DAY__: String(DAYS_PER_DAY),
  __PAYMENTS__: payments.enabled ? '1' : '0',
  __PRICES__: Object.entries(PRODUCTS).map(([k, pr]) => `${k}=${pr.price}`).join(';'),
});

const SECURITY = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()', // cámara: escanear QR · micrófono: dictado
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
      if (size > limit) return reject(new AppError(413, 'too_big', 'Petición demasiado grande', 'Request too large'));
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new AppError(400, 'json', 'JSON inválido', 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Cuerpo crudo (el webhook de Stripe se verifica byte a byte: no se puede parsear antes). */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => (size > limit ? reject(new AppError(413, 'too_big', 'Petición demasiado grande', 'Request too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/** El origen de la página que pidió el pago (para volver al mismo dominio, donde está su reloj). */
function originOf(req) {
  try {
    const o = new URL(req.headers.origin);
    if (o.host === req.headers.host && /^https?:$/.test(o.protocol)) return o.origin;
  } catch {}
  return config.publicUrl || `http://${req.headers.host}`;
}

const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
const clientIp = (req) =>
  String(req.headers['x-real-ip'] || '').trim() ||
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress;

/** Compara la clave de admin en tiempo constante (no se puede adivinar letra por letra midiendo tiempos). */
const sha = (s) => createHash('sha256').update(String(s)).digest();
const isAdmin = (req) => Boolean(config.adminToken) && timingSafeEqual(sha(bearer(req) || ''), sha(config.adminToken));

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
const limitAdmin = limiter(20, 60_000); // contra adivinar la clave de admin
const limitAccuse = limiter(5, 60_000);
const limitCheckout = limiter(10, 60_000);

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
  return { day: store.publicDay(id, dayId), state: store.state(id) }; // el estado trae las charlas que le quedan hoy
}

/** Aplica una acción de pago (del webhook o de consultar el checkout). Idempotente. */
function applyPayment(a) {
  switch (a.type) {
    case 'paid': {
      const r = store.fulfill({ provider: 'stripe', ...a });
      if (r.unknown) log.warn(`pago ${a.ref} sin reloj (usuario ${a.userId || '?'})`);
      return r;
    }
    case 'renewed':
      return store.renewPlus(a);
    case 'plus_ended':
      return store.endPlus(a);
    case 'plus_renews':
      return store.setPlusRenews(a);
    case 'refunded':
      return { refunded: store.refund(a.paymentRef) };
    default:
      return { ignored: true };
  }
}

/** La tienda de esta persona con precios (los nombres y textos los pone la app en su idioma). */
function storeView(id) {
  const info = store.storeInfo(id);
  return {
    enabled: payments.enabled,
    test: payments.testMode,
    currency: CURRENCY,
    ...info,
    products: info.products.map((pr) => ({ ...pr, price: PRODUCTS[pr.id].price, mode: PRODUCTS[pr.id].mode })),
  };
}

function requireJudge() {
  if (!judge.enabled) {
    throw new AppError(503, 'judge_off', 'El Guardián no está configurado: falta ANTHROPIC_API_KEY.', 'The Guardian is not configured: ANTHROPIC_API_KEY is missing.');
  }
}

/* ───────── API ───────── */

/** Idioma de la app que hace la petición ('en' o 'es'); '' si no lo manda (una versión vieja, en español). */
const langOf = (req) => cleanLang(req.headers['x-lang']);

async function api(req, res, p, qs) {
  const m = req.method;
  const lang = langOf(req);

  // Avisos de Stripe: sin llave, pero con firma (se rechaza todo lo que no venga de Stripe).
  if (m === 'POST' && p === '/api/stripe/webhook') {
    if (!payments.webhookReady) throw new AppError(404, 'not_found', 'Ruta desconocida', 'Unknown route');
    const raw = await readRaw(req, 1_000_000);
    const ev = payments.parseWebhook(raw, req.headers['stripe-signature']);
    const r = applyPayment(ev.action);
    log.info(`stripe ${ev.type} → ${ev.action.type}${r?.duplicate ? ' (repetido)' : ''}${r?.unknown ? ' (sin reloj)' : ''}`);
    return send(res, 200, { received: true });
  }

  if (m === 'POST' && p === '/api/session') {
    if (!limitSessions(clientIp(req))) throw new AppError(429, 'rate', 'Demasiados intentos, espera un rato', 'Too many attempts, wait a while');
    const b = await readJson(req);
    return send(res, 201, store.createUser({ nickname: b.nickname, deviceId: b.deviceId, ip: clientIp(req), lang }));
  }

  if (m === 'GET' && p === '/api/admin/stats') {
    if (!config.adminToken) throw new AppError(404, 'not_found', 'Ruta desconocida', 'Unknown route');
    if (!limitAdmin(clientIp(req))) throw new AppError(429, 'rate', 'Demasiados intentos, espera un minuto', 'Too many attempts, wait a minute');
    if (!isAdmin(req)) throw new AppError(401, 'admin', 'Clave de administrador incorrecta');
    return send(res, 200, store.adminStats());
  }
  if (m === 'GET' && p === '/api/push/key') return send(res, 200, { publicKey: push.publicKey });

  const user = store.auth(bearer(req));
  if (!user) throw new AppError(401, 'auth', 'Llave inválida', 'Invalid key');
  if (!limitApi(user.id)) throw new AppError(429, 'rate', 'Más despacio', 'Slow down');
  const id = user.id;
  if (lang && user.lang !== lang) store.setLang(id, lang); // así los avisos push y el Guardián le hablan en su idioma

  if (m === 'GET' && p === '/api/state') return send(res, 200, store.state(id));

  if (m === 'POST' && p === '/api/me/key') return send(res, 200, store.rotateToken(id));

  if (m === 'PATCH' && p === '/api/me') {
    const b = await readJson(req);
    if (b?.remindEvery !== undefined) return send(res, 200, store.setReminder(id, b.remindEvery, b.tz));
    if (typeof b?.ranked === 'boolean') return send(res, 200, store.setRanked(id, b.ranked));
    return send(res, 200, store.setNickname(id, b.nickname));
  }

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
    if (!limitClaims(id)) throw new AppError(429, 'rate', 'Demasiados intentos, espera un minuto', 'Too many attempts, wait a minute');
    const b = await readJson(req);
    const r = store.claimTransfer(id, b.code);
    push.sendToUser(r.fromUser, deliveredFor(r.fromLang, { name: r.toName, dur: fmtSeconds(r.seconds), gift: r.gift })).catch(() => {});
    return send(res, 200, { seconds: r.seconds, fromName: r.fromName, gift: Boolean(r.gift), state: r.state });
  }
  const transfer = /^\/api\/transfer\/([A-Za-z0-9]{6})$/.exec(p);
  if (transfer && m === 'GET') return send(res, 200, store.transferStatus(id, transfer[1]));
  if (transfer && m === 'DELETE') return send(res, 200, store.cancelTransfer(id, transfer[1]));

  // Tienda: Plus, +1 día, regalos y Revivir (Stripe)
  if (m === 'GET' && p === '/api/store') return send(res, 200, storeView(id));
  if (m === 'POST' && p === '/api/checkout') {
    if (!payments.enabled) throw new AppError(503, 'payments_off', 'Los pagos aún no están activos', "Payments aren't available yet");
    if (!limitCheckout(id)) throw new AppError(429, 'rate', 'Demasiados intentos, espera un minuto', 'Too many attempts, wait a minute');
    const b = await readJson(req);
    const product = String(b.product || '');
    if (!PRODUCTS[product]) throw new AppError(400, 'product', 'Producto desconocido', 'Unknown product');
    const { lifeNo, lang: userLang } = store.checkBuy(id, product);
    const out = await payments.createCheckout({ userId: id, product, lifeNo, origin: originOf(req), lang: lang || userLang });
    return send(res, 200, { url: out.url });
  }
  const checkout = /^\/api\/checkout\/(cs_[A-Za-z0-9_]{8,200})$/.exec(p);
  if (m === 'GET' && checkout) {
    // Al volver del pago: si el webhook aún no llegó, el servidor le pregunta a Stripe (nunca le cree al navegador).
    let found = store.purchaseOf(id, checkout[1]);
    if (found === false) throw new AppError(404, 'not_found', 'Ese pago no existe', "That payment doesn't exist");
    if (!found && payments.enabled) {
      const s = await payments.getSession(checkout[1]);
      if (s.userId !== id) throw new AppError(404, 'not_found', 'Ese pago no existe', "That payment doesn't exist");
      if (s.paid) {
        applyPayment({ type: 'paid', ...s });
        found = store.purchaseOf(id, checkout[1]);
      }
    }
    return send(res, 200, { status: found?.status || 'pendiente', ...found, state: store.state(id) });
  }
  if (m === 'POST' && p === '/api/plus/renewal') {
    const b = await readJson(req);
    const sub = store.plusSubOf(id);
    await payments.setRenewal(sub, b.renews === true);
    store.setPlusRenews({ subscription: sub, renews: b.renews === true });
    return send(res, 200, { state: store.state(id) });
  }
  if (m === 'POST' && p === '/api/revive') return send(res, 200, store.reviveFree(id));

  // Ranking, perfiles y juicios
  if (m === 'GET' && p === '/api/rank') return send(res, 200, store.ranking(id, qs.get('board') || 'semana'));
  const person = /^\/api\/people\/([A-Za-z0-9_-]{8})$/.exec(p);
  if (m === 'GET' && person) return send(res, 200, store.profile(id, person[1]));
  if (m === 'GET' && p === '/api/trials') return send(res, 200, store.trials(id));
  if (m === 'POST' && p === '/api/trials') {
    if (!limitAccuse(id)) throw new AppError(429, 'rate', 'Más despacio', 'Slow down');
    const b = await readJson(req);
    const r = store.accuse(id, { target: b.target, reason: b.reason, text: b.text });
    if (r.notify) push.sendToUser(r.notify.userId, { ...trialFor('open', r.notify.lang), kind: 'trial' }).catch(() => {});
    return send(res, 201, { opened: r.opened, trialId: r.trialId ?? null, count: r.count, needed: r.needed });
  }
  const trial = /^\/api\/trials\/(\d+)(?:\/(vote|defense))?$/.exec(p);
  if (trial) {
    const trialId = Number(trial[1]);
    if (m === 'GET' && !trial[2]) return send(res, 200, store.trial(id, trialId));
    if (m === 'POST' && trial[2] === 'vote') return send(res, 200, store.vote(id, trialId, (await readJson(req)).vote));
    if (m === 'POST' && trial[2] === 'defense') return send(res, 200, store.defend(id, trialId, (await readJson(req)).text));
  }

  if (p === '/api/push' && (m === 'POST' || m === 'DELETE')) {
    const b = await readJson(req);
    if (m === 'POST') store.addSub(id, b);
    else store.removeSub(id, b.endpoint);
    return send(res, 204);
  }

  throw new AppError(404, 'not_found', 'Ruta desconocida', 'Unknown route');
}

/* ───────── servidor ───────── */

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, version: site.version });
    if (p.startsWith('/api/')) return await api(req, res, p, url.searchParams);
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, site, p)) return;
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    const lang = langOf(req);
    if (err instanceof AppError) return send(res, err.status, { error: err.code, message: err.text(lang) });
    log.error(err);
    if (!res.headersSent) send(res, 500, { error: 'server', message: lang === 'en' ? 'Something went wrong on the server' : 'Algo falló en el servidor' });
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
