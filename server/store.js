import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES, lifeSeconds } from '../public/economy.js';

/** Umbrales de alerta en segundos: 24 h, 1 h, 10 min y el final. */
export const ALERTS = [86_400, 3_600, 600, 0];
export const VERDICTS = ['aprobado', 'rechazado', 'necesita_prueba', 'no_cuenta'];
export const MAX_REPLIES = 2;
const MAX_TX = 10 * 365 * 86_400;
const MAX_AMOUNT = { money: 10_000_000_000, hours: 24 };
const NOTE_MAX = 80;
const UNDO_WINDOW = 5 * 60_000;
const CAP_WINDOW = 86_400_000;
const MAX_SUBS = 10;
// Mi día
const DAYS_PER_24H = 5;
const DAY_TEXT_MAX = 2000;
const PHOTOS_PER_MSG = 4;
const PHOTOS_PER_DAY = 6;
const PHOTO_MAX_B64 = 1_500_000;
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Transferencias
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
const TRANSFER_TTL = 10 * 60_000;
const MAX_PENDING = 3;
const KEEP_MS = 60_000; // nadie puede regalar hasta quedar en cero

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Menor umbral ya cruzado para este tiempo restante, o null si quedan más de 24 h. */
export function alertBand(remainingMs) {
  let band = null;
  for (const t of ALERTS) if (remainingMs <= t * 1000) band = t;
  return band;
}

const hashToken = (token) => createHash('sha256').update(token).digest('base64url');

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`;

// Cada entrada se aplica una sola vez (PRAGMA user_version). Nunca editar una ya publicada: agregar otra.
export const MIGRATIONS = [
  // v1 · base
  `
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    life_no     INTEGER NOT NULL,
    born_at     INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,   -- la única verdad: cuándo se agota el tiempo (ms)
    alerted     INTEGER             -- menor umbral de alerta ya avisado en esta racha
  );
  CREATE INDEX IF NOT EXISTS users_expires ON users (expires_at);

  CREATE TABLE IF NOT EXISTS ledger (
    id       INTEGER PRIMARY KEY,
    user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    life_no  INTEGER NOT NULL,
    at       INTEGER NOT NULL,
    seconds  INTEGER NOT NULL,      -- positivo: ganado · negativo: gastado
    note     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS ledger_user ON ledger (user_id, life_no, id DESC);

  CREATE TABLE IF NOT EXISTS lives (
    user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    life_no   INTEGER NOT NULL,
    born_at   INTEGER NOT NULL,
    ended_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, life_no)
  );

  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint    TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_user ON push_subs (user_id);

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // v2 · economía: cada movimiento guarda su categoría, el valor original y su estado de prueba
  `
  ALTER TABLE ledger ADD COLUMN category TEXT NOT NULL DEFAULT 'tiempo';
  ALTER TABLE ledger ADD COLUMN amount REAL NOT NULL DEFAULT 0;
  ALTER TABLE ledger ADD COLUMN status TEXT NOT NULL DEFAULT 'declarado';  -- declarado · pendiente · verificado · rechazado
  CREATE INDEX IF NOT EXISTS ledger_cat ON ledger (user_id, category, at);
  `,
  // v3 · "Mi día" con el Guardián + transferencias de tiempo
  `
  CREATE TABLE IF NOT EXISTS days (
    id          INTEGER PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'abierto',   -- abierto · aceptado · descartado
    rounds      INTEGER NOT NULL DEFAULT 0,        -- réplicas usadas
    turns       TEXT NOT NULL,                     -- JSON de la conversación (sin fotos)
    images      TEXT,                              -- JSON de fotos; se borra al cerrar el día
    verdict     TEXT                               -- último veredicto
  );
  CREATE INDEX IF NOT EXISTS days_user ON days (user_id, created_at);

  CREATE TABLE IF NOT EXISTS proof_hashes (
    hash     TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL,
    used_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transfers (
    code        TEXT PRIMARY KEY,
    from_user   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    seconds     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    ledger_id   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pendiente', -- pendiente · entregado · devuelto
    to_user     TEXT,
    done_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS transfers_pending ON transfers (status, expires_at);
  `,
  // v4 · nombre o apodo visible (base de los futuros rankings)
  `
  ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
  `,
  // v5 · anti-abuso: dispositivo anónimo + huella cifrada de la red (nunca la IP) y motivo de cada renacer
  `
  ALTER TABLE users ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';
  ALTER TABLE lives ADD COLUMN reason TEXT NOT NULL DEFAULT 'muerte';   -- muerte · reinicio
  CREATE INDEX IF NOT EXISTS users_device ON users (device_id);
  CREATE INDEX IF NOT EXISTS users_ip ON users (ip_hash);
  `,
  // v6 · limpieza: nadie debe tener su llave como nombre (se vería en rankings y en /admin). No toca relojes.
  `
  UPDATE users SET nickname = '' WHERE instr(lower(nickname), 'tk_') > 0;
  `,
];

/** Identificador anónimo que genera la app en cada teléfono. Si no tiene la forma esperada, se ignora. */
const cleanDevice = (d) => (typeof d === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(d) ? d : '');

/** La "red" de una IP: IPv4 tal cual; IPv6 por su prefijo /64 (los celulares rotan el resto por privacidad). */
function networkOf(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return '';
  ip = ip.trim().replace(/^::ffff:/i, '');
  if (!ip.includes(':')) return ip;
  const groups = ip.split(':');
  return groups.slice(0, 4).every(Boolean) ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

const NICK_MAX = 32;
const graphemes = new Intl.Segmenter('es', { granularity: 'grapheme' });
/**
 * Nombre o apodo: máximo 32 caracteres "de los que se ven" (un emoji cuenta como uno).
 * Quita controles y marcas invisibles de dirección/ancho cero que sirven para suplantar nombres.
 */
export function cleanNickname(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw
    .normalize('NFC')
    .replace(/\s+/g, ' ') // primero tabs/saltos → espacio (si no, el tab se borra y pega las palabras)
    .replace(/[\p{Cc}\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = s.replace(/tk_[A-Za-z0-9_-]{10,}/gi, '').replace(/\s+/g, ' ').trim(); // una llave nunca es un nombre
  return [...graphemes.segment(safe)].slice(0, NICK_MAX).map((g) => g.segment).join('').trim();
}

const sha256 = (s) => createHash('sha256').update(s).digest('base64url');

function newCode() {
  // 256 es múltiplo de 32: sin sesgo
  return [...randomBytes(6)].map((b) => CODE_ALPHABET[b % 32]).join('');
}
export const normalizeCode = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Copia completa y consistente de la base (VACUUM INTO) antes de migrar.
 * Si una actualización saliera mal, los relojes se restauran desde aquí. Se guardan las 3 más recientes.
 */
function backup(db, dir, version) {
  const file = path.join(dir, `backup-v${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  const copies = fs
    .readdirSync(dir)
    .filter((f) => /^backup-v\d+-.+\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of copies.slice(3)) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openStore({ dir, initialSeconds = 7 * 86_400, minWage = 1_750_905, now = Date.now } = {}) {
  let file = ':memory:';
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'tiempo.db');
  }
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  // Base existente con migraciones pendientes → copia de seguridad primero. Las migraciones solo agregan, nunca borran.
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  const backupFile = dir && version > 0 && version < MIGRATIONS.length ? backup(db, dir, version) : null;
  migrate(db);
  const initialMs = initialSeconds * 1000;

  const st = (sql) => db.prepare(sql);
  const q = {
    insertUser: st(`INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at, nickname, device_id, ip_hash)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`),
    adminUsers: st(`
      SELECT u.nickname, u.created_at, u.life_no, u.expires_at, u.device_id, u.ip_hash,
             (SELECT COUNT(*) FROM lives l WHERE l.user_id = u.id AND l.reason = 'reinicio') AS reinicios,
             (SELECT COUNT(*) FROM lives l WHERE l.user_id = u.id AND l.reason = 'muerte')   AS muertes
      FROM users u ORDER BY u.created_at DESC`),
    setNick: st('UPDATE users SET nickname = ? WHERE id = ?'),
    byHash: st('SELECT * FROM users WHERE token_hash = ?'),
    byId: st('SELECT * FROM users WHERE id = ?'),
    setExpiry: st('UPDATE users SET expires_at = ?, alerted = ? WHERE id = ?'),
    newLife: st('UPDATE users SET life_no = life_no + 1, born_at = ?, expires_at = ?, alerted = NULL WHERE id = ?'),
    endLife: st('INSERT OR REPLACE INTO lives (user_id, life_no, born_at, ended_at, reason) VALUES (?, ?, ?, ?, ?)'),
    record: st('SELECT MAX(ended_at - born_at) AS ms FROM lives WHERE user_id = ?'),
    addTx: st(`INSERT INTO ledger (user_id, life_no, at, seconds, note, category, amount, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    ledgerRow: st('SELECT * FROM ledger WHERE id = ?'),
    dayInsert: st('INSERT INTO days (user_id, created_at, turns, images) VALUES (?, ?, ?, ?)'),
    dayGet: st('SELECT * FROM days WHERE id = ? AND user_id = ?'),
    dayById: st('SELECT * FROM days WHERE id = ?'),
    daySave: st('UPDATE days SET turns = ?, images = ?, verdict = ?, rounds = ? WHERE id = ?'),
    dayClose: st('UPDATE days SET status = ?, images = NULL WHERE id = ?'),
    dayDelete: st('DELETE FROM days WHERE id = ?'),
    daysSince: st('SELECT COUNT(*) AS n FROM days WHERE user_id = ? AND created_at > ?'),
    dayPurge: st(`UPDATE days SET status = 'descartado', images = NULL WHERE status = 'abierto' AND created_at < ?`),
    hashUsed: st('SELECT 1 AS used FROM proof_hashes WHERE hash = ?'),
    hashAdd: st('INSERT OR IGNORE INTO proof_hashes (hash, user_id, used_at) VALUES (?, ?, ?)'),
    trInsert: st('INSERT INTO transfers (code, from_user, seconds, created_at, expires_at, ledger_id) VALUES (?, ?, ?, ?, ?, ?)'),
    trGet: st('SELECT * FROM transfers WHERE code = ?'),
    trSet: st('UPDATE transfers SET status = ?, to_user = ?, done_at = ? WHERE code = ?'),
    trPending: st(`SELECT COUNT(*) AS n FROM transfers WHERE from_user = ? AND status = 'pendiente'`),
    trExpired: st(`SELECT * FROM transfers WHERE status = 'pendiente' AND expires_at <= ?`),
    usedSince: st('SELECT COALESCE(SUM(amount), 0) AS used FROM ledger WHERE user_id = ? AND category = ? AND at > ?'),
    txById: st('SELECT * FROM ledger WHERE id = ? AND user_id = ?'),
    delTx: st('DELETE FROM ledger WHERE id = ?'),
    ledger: st(`SELECT id, at, seconds, note, category, amount, status FROM ledger
                WHERE user_id = ? AND life_no = ? ORDER BY id DESC LIMIT 200`),
    totals: st(`
      SELECT COALESCE(SUM(CASE WHEN seconds > 0 THEN seconds END), 0)  AS earned,
             COALESCE(-SUM(CASE WHEN seconds < 0 THEN seconds END), 0) AS spent
      FROM ledger WHERE user_id = ? AND life_no = ?`),
    upsertSub: st(`
      INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`),
    trimSubs: st(`
      DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (
        SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_SUBS})`),
    delSub: st('DELETE FROM push_subs WHERE endpoint = ?'),
    delUserSub: st('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?'),
    subsFor: st('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'),
    due: st(`
      SELECT id, expires_at, alerted FROM users
      WHERE expires_at <= ? AND (alerted IS NULL OR alerted > 0)
        AND EXISTS (SELECT 1 FROM push_subs s WHERE s.user_id = users.id)`),
    setAlerted: st('UPDATE users SET alerted = ? WHERE id = ?'),
    getMeta: st('SELECT value FROM meta WHERE key = ?'),
    setMeta: st('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  };

  // Secreto propio de esta base para la huella de red: sin él, la huella no se puede revertir a la IP.
  let pepper = q.getMeta.get('pepper');
  pepper = pepper ? JSON.parse(pepper.value) : null;
  if (!pepper) {
    pepper = randomBytes(32).toString('base64url');
    q.setMeta.run('pepper', JSON.stringify(pepper));
  }
  const hashNetwork = (ip) => {
    const net = networkOf(ip);
    return net ? createHmac('sha256', pepper).update(net).digest('base64url').slice(0, 16) : '';
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function must(id) {
    const u = q.byId.get(id);
    if (!u) throw new AppError(401, 'auth', 'Llave inválida');
    return u;
  }

  function snapshot(u) {
    const totals = q.totals.get(u.id, u.life_no);
    return {
      now: now(),
      nickname: u.nickname,
      lifeNo: u.life_no,
      bornAt: u.born_at,
      expiresAt: u.expires_at,
      initialSeconds,
      earned: totals.earned,
      spent: totals.spent,
      record: q.record.get(u.id).ms ?? 0,
      ledger: q.ledger.all(u.id, u.life_no).map((r) => ({ ...r })),
    };
  }

  /* ───────── Mi día: utilidades ───────── */

  function cleanImages(images, already) {
    if (images == null) return [];
    if (!Array.isArray(images)) throw new AppError(400, 'images', 'Fotos inválidas');
    if (images.length > PHOTOS_PER_MSG || already + images.length > PHOTOS_PER_DAY) {
      throw new AppError(400, 'images', `Máximo ${PHOTOS_PER_MSG} fotos por mensaje y ${PHOTOS_PER_DAY} por día`);
    }
    return images.map((im) => {
      const ok =
        im && MEDIA.has(im.media_type) && typeof im.data === 'string' &&
        im.data.length > 100 && im.data.length <= PHOTO_MAX_B64 && /^[A-Za-z0-9+/]+=*$/.test(im.data);
      if (!ok) throw new AppError(400, 'images', 'Foto inválida o demasiado grande');
      return { media_type: im.media_type, data: im.data, hash: sha256(im.data) };
    });
  }

  function loadDay(row) {
    return {
      id: row.id,
      userId: row.user_id,
      status: row.status,
      rounds: row.rounds,
      createdAt: row.created_at,
      turns: JSON.parse(row.turns),
      images: row.images ? JSON.parse(row.images) : [],
      verdict: row.verdict ? JSON.parse(row.verdict) : null,
    };
  }

  function openDayOf(id, dayId) {
    const row = q.dayGet.get(dayId, id);
    if (!row) throw new AppError(404, 'not_found', 'Ese día no existe');
    const day = loadDay(row);
    if (day.status !== 'abierto') throw new AppError(409, 'closed', 'Ese día ya se cerró');
    return day;
  }

  function saveDay(day) {
    q.daySave.run(JSON.stringify(day.turns), JSON.stringify(day.images), day.verdict && JSON.stringify(day.verdict), day.rounds, day.id);
  }

  /** Lo que la IA devolvió, saneado: nunca confiamos en su forma ni en sus números. */
  function cleanVerdict(v) {
    const items = (Array.isArray(v?.items) ? v.items : []).slice(0, 20).map((it) => {
      const c = CATEGORIES[it?.category];
      const valid = c && !c.system;
      let amount = Number(it?.amount);
      if (!valid || !Number.isFinite(amount) || amount < 0) amount = 0;
      else amount = Math.min(amount, MAX_AMOUNT[c.unit]);
      if (valid && c.unit === 'money') amount = Math.round(amount);
      if (valid && c.unit === 'hours') amount = Math.round(amount * 100) / 100;
      return {
        activity: String(it?.activity ?? '').slice(0, 60),
        category: valid ? it.category : 'ninguna',
        amount,
        verdict: VERDICTS.includes(it?.verdict) && valid ? it.verdict : 'no_cuenta',
        reason: String(it?.reason ?? '').slice(0, 200),
      };
    });
    return { message: String(v?.message ?? '').slice(0, 600), items };
  }

  /** Tiempo de vida de cada ítem aprobado, respetando los topes de las últimas 24 h. */
  function priceItems(u, items, t) {
    const used = {};
    return items.map((it) => {
      const c = CATEGORIES[it.category];
      if (it.verdict !== 'aprobado' || !c || c.system || !(it.amount > 0)) return { ...it, seconds: 0 };
      let amount = it.amount;
      let capped = false;
      if (c.cap) {
        used[it.category] ??= q.usedSince.get(u.id, it.category, t - CAP_WINDOW).used;
        const room = Math.max(0, c.cap - used[it.category]);
        if (amount > room) (amount = room), (capped = true);
        used[it.category] += amount;
      }
      return { ...it, amount, capped, seconds: lifeSeconds(it.category, amount, minWage) };
    });
  }

  /* ───────── transferencias: utilidades ───────── */

  /** Devuelve el tiempo de un código no reclamado (si quien lo envió sigue en la misma vida). */
  function refund(tr, t) {
    const row = q.ledgerRow.get(tr.ledger_id);
    const u = q.byId.get(tr.from_user);
    if (row && u && u.life_no === row.life_no && u.expires_at > t) {
      q.delTx.run(row.id);
      const expires = u.expires_at + tr.seconds * 1000;
      q.setExpiry.run(expires, alertBand(expires - t), u.id);
    }
    q.trSet.run('devuelto', null, t, tr.code);
  }

  return {
    createUser({ nickname, deviceId, ip } = {}) {
      const token = 'tk_' + randomBytes(18).toString('base64url');
      const id = randomUUID();
      const t = now();
      q.insertUser.run(id, hashToken(token), t, t, t + initialMs, cleanNickname(nickname), cleanDevice(deviceId), hashNetwork(ip));
      return { token, state: snapshot(must(id)) };
    },

    setNickname(id, nickname) {
      must(id);
      q.setNick.run(cleanNickname(nickname), id);
      return { state: snapshot(must(id)) };
    },

    auth(token) {
      if (typeof token !== 'string' || token.length < 10 || token.length > 100) return null;
      return q.byHash.get(hashToken(token)) ?? null;
    },

    state: (id) => snapshot(must(id)),

    /** Registra una actividad. El servidor calcula el tiempo con la fórmula; el cliente no decide. */
    addTx(id, { category, amount, note } = {}) {
      const c = CATEGORIES[category];
      if (!c || c.system) throw new AppError(400, 'category', 'Categoría desconocida');
      if (c.proof !== 'none') throw new AppError(400, 'needs_judge', `${c.label} se cuenta en "Mi día", con el Guardián`);
      amount = Number(amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT[c.unit]) {
        throw new AppError(400, 'amount', 'Cantidad inválida');
      }
      amount = c.unit === 'money' ? Math.round(amount) : Math.round(amount * 100) / 100;
      const seconds = lifeSeconds(category, amount, minWage);
      if (!seconds || Math.abs(seconds) > MAX_TX) throw new AppError(400, 'amount', 'Cantidad inválida');
      note = typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '';

      return tx(() => {
        const u = must(id);
        const t = now();
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó');
        if (c.cap) {
          const { used } = q.usedSince.get(u.id, category, t - CAP_WINDOW);
          if (used + amount > c.cap + 1e-9) {
            throw new AppError(409, 'cap', `Máximo ${c.cap} h de ${c.label.toLowerCase()} cada 24 horas`);
          }
        }
        const expires = u.expires_at + seconds * 1000;
        if (expires <= t) throw new AppError(409, 'insufficient', 'No te alcanza el tiempo');
        const r = q.addTx.run(u.id, u.life_no, t, seconds, note, category, amount, 'declarado');
        // Si el propio usuario se acerca a un umbral, no le avisamos de lo que ya sabe.
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        return {
          tx: { id: Number(r.lastInsertRowid), at: t, seconds, note, category, amount, status: 'declarado' },
          state: snapshot(must(id)),
        };
      });
    },

    undoTx(id, txId) {
      return tx(() => {
        const u = must(id);
        const row = q.txById.get(txId, u.id);
        const t = now();
        if (!row || row.life_no !== u.life_no) throw new AppError(404, 'not_found', 'Ese movimiento ya no existe');
        if (CATEGORIES[row.category]?.system) throw new AppError(409, 'system', 'Las transferencias no se deshacen');
        if (t - row.at > UNDO_WINDOW) throw new AppError(409, 'too_late', 'Ya no se puede deshacer');
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó');
        const expires = u.expires_at - row.seconds * 1000;
        if (expires <= t) throw new AppError(409, 'insufficient', 'Deshacerlo te dejaría en cero');
        q.delTx.run(row.id);
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        return { state: snapshot(must(id)) };
      });
    },

    rebirth(id, force = false) {
      return tx(() => {
        const u = must(id);
        const t = now();
        if (u.expires_at > t && !force) throw new AppError(409, 'alive', 'Aún tienes tiempo');
        // ¿Se le acabó el tiempo o reinició teniendo tiempo? Sirve para ver quién aprovecha las vidas.
        const reason = u.expires_at > t ? 'reinicio' : 'muerte';
        q.endLife.run(u.id, u.life_no, u.born_at, Math.min(u.expires_at, t), reason);
        q.newLife.run(t, t + initialMs, u.id);
        return { state: snapshot(must(id)) };
      });
    },

    /* ───────── Mi día ───────── */

    openDay(id, { text, images } = {}) {
      const u = must(id);
      const t = now();
      if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó');
      if (q.daysSince.get(id, t - CAP_WINDOW).n >= DAYS_PER_24H) {
        throw new AppError(429, 'days', `Ya le contaste ${DAYS_PER_24H} veces al Guardián hoy. Vuelve mañana.`);
      }
      text = typeof text === 'string' ? text.trim().slice(0, DAY_TEXT_MAX) : '';
      if (!text) throw new AppError(400, 'text', 'Cuéntale al Guardián qué hiciste');
      const imgs = cleanImages(images, 0);
      const turns = [{ role: 'user', text, photos: imgs.length }];
      const r = q.dayInsert.run(id, t, JSON.stringify(turns), JSON.stringify(imgs));
      return { id: Number(r.lastInsertRowid) };
    },

    replyDay(id, dayId, { text, images } = {}) {
      const day = openDayOf(id, dayId);
      if (day.turns.at(-1)?.role !== 'judge') throw new AppError(409, 'waiting', 'Espera el veredicto');
      if (day.rounds >= MAX_REPLIES) throw new AppError(409, 'final', 'El Guardián ya tomó su decisión final');
      text = typeof text === 'string' ? text.trim().slice(0, DAY_TEXT_MAX) : '';
      const imgs = cleanImages(images, day.images.length);
      if (!text && !imgs.length) throw new AppError(400, 'text', 'Escribe tu réplica o sube una prueba');
      day.turns.push({ role: 'user', text, photos: imgs.length });
      day.images.push(...imgs);
      day.rounds += 1;
      saveDay(day);
    },

    /** Lo que se le manda a la IA: conversación + fotos, marcando las que ya se usaron como prueba. */
    judgeInput(id, dayId) {
      const day = openDayOf(id, dayId);
      return {
        turns: day.turns,
        images: day.images.map((im) => ({ ...im, reused: Boolean(q.hashUsed.get(im.hash)) })),
        now: now(),
      };
    },

    saveVerdict(dayId, verdict) {
      const day = loadDay(q.dayById.get(dayId));
      const clean = cleanVerdict(verdict);
      day.turns.push({ role: 'judge', verdict: clean });
      day.verdict = clean;
      saveDay(day);
    },

    /** Si la IA falla, el último mensaje no cuenta: se puede volver a intentar. */
    rollbackDay(dayId) {
      const row = q.dayById.get(dayId);
      if (!row) return;
      const day = loadDay(row);
      const last = day.turns.at(-1);
      if (last?.role !== 'user') return;
      if (day.turns.length === 1) return void q.dayDelete.run(dayId);
      day.turns.pop();
      day.images.splice(day.images.length - last.photos, last.photos);
      day.rounds -= 1;
      saveDay(day);
    },

    publicDay(id, dayId) {
      const row = q.dayGet.get(dayId, id);
      if (!row) throw new AppError(404, 'not_found', 'Ese día no existe');
      const day = loadDay(row);
      const u = must(id);
      const t = now();
      const turns = day.turns.map((turn) =>
        turn.role === 'judge'
          ? { role: 'judge', message: turn.verdict.message, items: priceItems(u, turn.verdict.items, t) }
          : { role: 'user', text: turn.text, photos: turn.photos },
      );
      const last = turns.findLast((x) => x.role === 'judge');
      return {
        id: day.id,
        status: day.status,
        rounds: day.rounds,
        maxReplies: MAX_REPLIES,
        turns,
        net: last ? last.items.reduce((s, it) => s + it.seconds, 0) : 0,
      };
    },

    acceptDay(id, dayId) {
      return tx(() => {
        const day = openDayOf(id, dayId);
        if (!day.verdict) throw new AppError(409, 'waiting', 'Aún no hay veredicto');
        const u = must(id);
        const t = now();
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó');
        const items = priceItems(u, day.verdict.items, t).filter((it) => it.seconds);
        let expires = u.expires_at;
        for (const it of items) {
          const status = CATEGORIES[it.category].proof === 'photo' ? 'verificado' : 'aprobado';
          q.addTx.run(u.id, u.life_no, t, it.seconds, it.activity, it.category, it.amount, status);
          expires += it.seconds * 1000;
        }
        if (expires <= t) expires = t; // gastó más de lo que tenía: se acabó
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        for (const im of day.images) q.hashAdd.run(im.hash, u.id, t); // una foto prueba una sola vez
        q.dayClose.run('aceptado', day.id);
        return { net: items.reduce((s, it) => s + it.seconds, 0), state: snapshot(must(id)) };
      });
    },

    discardDay(id, dayId) {
      const day = openDayOf(id, dayId);
      q.dayClose.run('descartado', day.id);
    },

    purgeDays(t = now()) {
      q.dayPurge.run(t - CAP_WINDOW);
    },

    /* ───────── transferencias ───────── */

    createTransfer(id, seconds) {
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > MAX_TX) {
        throw new AppError(400, 'amount', 'Cantidad inválida (mínimo 1 minuto)');
      }
      return tx(() => {
        const u = must(id);
        const t = now();
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó');
        if (q.trPending.get(id).n >= MAX_PENDING) throw new AppError(429, 'pending', `Ya tienes ${MAX_PENDING} códigos activos`);
        const expires = u.expires_at - seconds * 1000;
        if (expires - t < KEEP_MS) throw new AppError(409, 'insufficient', 'No puedes regalar todo tu tiempo');
        let code;
        do code = newCode();
        while (q.trGet.get(code));
        const r = q.addTx.run(u.id, u.life_no, t, -seconds, `Código ${code}`, 'envio', seconds, 'enviado');
        q.trInsert.run(code, u.id, seconds, t, t + TRANSFER_TTL, Number(r.lastInsertRowid));
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        return { transfer: { code, seconds, expiresAt: t + TRANSFER_TTL }, state: snapshot(must(id)) };
      });
    },

    claimTransfer(id, rawCode) {
      const code = normalizeCode(rawCode);
      if (!/^[A-Z2-9]{6}$/.test(code)) throw new AppError(400, 'code', 'Código inválido');
      const result = tx(() => {
        const u = must(id);
        const t = now();
        const tr = q.trGet.get(code);
        if (!tr || tr.status !== 'pendiente') return { error: new AppError(404, 'code', 'Código inválido o ya usado') };
        if (tr.expires_at <= t) {
          refund(tr, t); // se guarda la devolución y luego se avisa del error
          return { error: new AppError(410, 'expired', 'Ese código ya expiró') };
        }
        if (tr.from_user === u.id) return { error: new AppError(409, 'own', 'Ese código es tuyo') };
        if (u.expires_at <= t) return { error: new AppError(409, 'dead', 'Tu reloj está en cero: renace primero') };
        q.addTx.run(u.id, u.life_no, t, tr.seconds, `Código ${code}`, 'recibo', tr.seconds, 'recibido');
        const expires = u.expires_at + tr.seconds * 1000;
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        q.trSet.run('entregado', u.id, t, code);
        return { seconds: tr.seconds, fromUser: tr.from_user, state: snapshot(must(id)) };
      });
      if (result.error) throw result.error;
      return result;
    },

    cancelTransfer(id, rawCode) {
      return tx(() => {
        const tr = q.trGet.get(normalizeCode(rawCode));
        if (!tr || tr.from_user !== id) throw new AppError(404, 'code', 'Ese código no existe');
        if (tr.status !== 'pendiente') throw new AppError(409, 'done', 'Ese código ya se usó');
        refund(tr, now());
        return { state: snapshot(must(id)) };
      });
    },

    transferStatus(id, rawCode) {
      const tr = q.trGet.get(normalizeCode(rawCode));
      if (!tr || tr.from_user !== id) throw new AppError(404, 'code', 'Ese código no existe');
      return { code: tr.code, status: tr.status, seconds: tr.seconds, expiresAt: tr.expires_at };
    },

    expireTransfers(t = now()) {
      return tx(() => {
        const due = q.trExpired.all(t);
        for (const tr of due) refund(tr, t);
        return due.length;
      });
    },

    addSub(id, sub) {
      const { endpoint, keys } = sub ?? {};
      const ok = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
      if (!ok(endpoint, 1024) || !endpoint.startsWith('https://') || !ok(keys?.p256dh, 256) || !ok(keys?.auth, 256)) {
        throw new AppError(400, 'subscription', 'Suscripción inválida');
      }
      q.upsertSub.run(endpoint, id, keys.p256dh, keys.auth, now());
      q.trimSubs.run(id, id);
    },

    removeSub(id, endpoint) {
      if (typeof endpoint === 'string') q.delUserSub.run(endpoint, id);
    },

    subsFor: (id) => q.subsFor.all(id),
    deleteSub: (endpoint) => q.delSub.run(endpoint),

    /** Marca y devuelve las alertas que tocan ahora. Síncrono: sin carreras con las escrituras. */
    claimAlerts(t = now()) {
      return tx(() => {
        const out = [];
        for (const u of q.due.all(t + ALERTS[0] * 1000)) {
          const band = alertBand(u.expires_at - t);
          if (band === null || (u.alerted !== null && band >= u.alerted)) continue;
          q.setAlerted.run(band, u.id);
          out.push({ userId: u.id, band, expiresAt: u.expires_at });
        }
        return out;
      });
    },

    /** Resumen para el administrador: cuentas repetidas por dispositivo o red, reinicios y muertes. */
    adminStats(t = now()) {
      const users = q.adminUsers.all();
      const short = (s) => (s ? s.slice(0, 8) : '—');
      const grouped = (key) => {
        const groups = new Map();
        for (const u of users) if (u[key]) groups.set(u[key], [...(groups.get(u[key]) || []), u]);
        return [...groups]
          .filter(([, list]) => list.length > 1)
          .map(([k, list]) => ({
            id: short(k),
            cuentas: list.length,
            nombres: list.map((u) => u.nickname || '(sin nombre)'),
            creadas: list.map((u) => u.created_at),
          }))
          .sort((a, b) => b.cuentas - a.cuentas);
      };
      const sum = (k) => users.reduce((s, u) => s + u[k], 0);
      return {
        ahora: t,
        totales: {
          relojes: users.length,
          vivos: users.filter((u) => u.expires_at > t).length,
          enCero: users.filter((u) => u.expires_at <= t).length,
          reinicios: sum('reinicios'),
          muertes: sum('muertes'),
          dispositivos: new Set(users.map((u) => u.device_id).filter(Boolean)).size,
          redes: new Set(users.map((u) => u.ip_hash).filter(Boolean)).size,
        },
        dispositivosConVariasCuentas: grouped('device_id'),
        redesConVariasCuentas: grouped('ip_hash'),
        relojes: users.slice(0, 500).map((u) => ({
          nombre: u.nickname,
          creado: u.created_at,
          vida: u.life_no,
          reinicios: u.reinicios,
          muertes: u.muertes,
          restanteSeg: Math.max(0, Math.round((u.expires_at - t) / 1000)),
          dispositivo: short(u.device_id),
          red: short(u.ip_hash),
        })),
      };
    },

    getMeta(key) {
      const row = q.getMeta.get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setMeta: (key, value) => q.setMeta.run(key, JSON.stringify(value)),

    backupFile,
    close: () => db.close(),
  };
}
