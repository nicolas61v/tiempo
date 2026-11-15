import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORIES, lifeSeconds, catText, dayValue, leagueOf, MONEY, MONEY_CATS, HOUR_CATS, HOURS_PER_DAY,
  BIO_MAX, strikeSeconds,
} from '../public/economy.js';
import { cleanCountry } from '../public/countries.js';
import { payStore } from './store-pay.js';
import { socialStore } from './store-social.js';

/** Umbrales de alerta en segundos: 24 h, 1 h, 10 min y el final. */
export const ALERTS = [86_400, 3_600, 600, 0];
export const VERDICTS = ['aprobado', 'rechazado', 'necesita_prueba', 'no_cuenta'];
export const MAX_REPLIES = 2;
/** Tiempo Plus (suscripción): más charlas y réplicas, un Guardián más fino y un Revivir gratis al mes. Nunca da tiempo. */
export const PLUS = { daysPerDay: 15, replies: 3, reviveEvery: 30 * 86_400_000 };
const DAY_S = 86_400;
const DAY_MS = DAY_S * 1000;
/** Lista SQL de categorías (son claves fijas de economy.js, nunca texto de la gente). */
export const sqlList = (keys) => keys.map((k) => `'${k}'`).join(', ');
const BOUGHT_CATS = Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].bought);
/** "3,5 días" / "3.5 days": para mensajes de error del servidor. */
function daysText(seconds, lang) {
  const n = Math.round((seconds / DAY_S) * 10) / 10;
  const s = lang === 'en' ? String(n) : String(n).replace('.', ',');
  return `${s} ${lang === 'en' ? (n === 1 ? 'day' : 'days') : n === 1 ? 'día' : 'días'}`;
}
/** Recordatorio de contarle el día al Guardián: cada cuánto (segundos) se puede elegir; 0 = nunca. */
export const REMIND_OPTIONS = [0, 21_600, 43_200, 86_400];
const QUIET_FROM = 22; // de 22:00 a 8:00, en la hora de la persona, no se recuerda nada
const QUIET_TO = 8;
const DEFAULT_TZ = 'America/Bogota';
const MAX_TX = 10 * 365 * 86_400;
const MAX_AMOUNT = { money: 10_000_000_000, hours: 24 };
const NOTE_MAX = 80;
const UNDO_WINDOW = 5 * 60_000;
const CAP_WINDOW = 86_400_000;
const MAX_SUBS = 10;
// Mi día: charlas con el Guardián por fecha del calendario (se renuevan a medianoche en la hora de la persona)
export const DAYS_PER_DAY = 7;
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

/** Error para quien usa la app. message: en español; en: en inglés (si falta, se responde en español). */
export class AppError extends Error {
  constructor(status, code, message, en) {
    super(message);
    this.status = status;
    this.code = code;
    this.en = en;
  }

  /** El mensaje en el idioma de quien pregunta ('en' o 'es'). */
  text(lang) {
    return (lang === 'en' && this.en) || this.message;
  }
}

/**
 * Moneda en la que cada quien ve y escribe la plata. Por dentro todo es en pesos colombianos (una sola economía:
 * 1 día de vida = 1 salario mínimo diario de Colombia); quien usa dólares los ve convertidos con USD_COP.
 */
export const CURRENCIES = ['COP', 'USD'];
export const cleanCurrency = (c) => (CURRENCIES.includes(c) ? c : '');
/** La moneda que le toca por su país si no eligió otra: Colombia en pesos, el resto en dólares. */
export const currencyFor = (country) => (country && country !== 'CO' ? 'USD' : 'COP');

/** Idioma válido de la app o '' (sin elegir: la app usa inglés por defecto). */
export const cleanLang = (lang) => (lang === 'en' || lang === 'es' ? lang : '');

/** Menor umbral ya cruzado para este tiempo restante, o null si quedan más de 24 h. */
export function alertBand(remainingMs) {
  let band = null;
  for (const t of ALERTS) if (remainingMs <= t * 1000) band = t;
  return band;
}

/** Zona horaria IANA válida (la que manda el teléfono) o '' (se usa la de Colombia). */
export function cleanTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return '';
  }
}

const hourFormats = new Map();
/** Hora local (0–23) de una persona en el instante t. */
export function localHour(t, tz) {
  const zone = tz || DEFAULT_TZ;
  let f = hourFormats.get(zone);
  if (!f) hourFormats.set(zone, (f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })));
  return Number(f.format(t)) % 24;
}

const dateFormats = new Map();
/** Instante (ms) en que empezó la fecha de hoy (00:00) en la zona de la persona, con cambio de hora incluido. */
export function startOfLocalDay(t, tz) {
  const zone = tz || DEFAULT_TZ;
  let f = dateFormats.get(zone);
  if (!f) {
    const opts = { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' };
    dateFormats.set(zone, (f = new Intl.DateTimeFormat('en-US', opts)));
  }
  const parts = (x) => Object.fromEntries(f.formatToParts(x).map((p) => [p.type, Number(p.value)]));
  // Desfase de la zona en el instante x: su hora de reloj leída como si fuera UTC, menos x.
  const offsetAt = (x) => {
    const p = parts(x);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - (x - (x % 1000));
  };
  const p = parts(t);
  const midnight = Date.UTC(p.year, p.month - 1, p.day);
  // Segunda pasada: si hoy cambió la hora, vale el desfase que había a la medianoche, no el de ahora.
  return midnight - offsetAt(midnight - offsetAt(t));
}

const newToken = () => 'tk_' + randomBytes(18).toString('base64url');
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
  // v7 · recordatorio de "Mi día" (por defecto cada 12 h, solo a quien tiene alertas). Solo agrega columnas: no toca relojes.
  `
  ALTER TABLE users ADD COLUMN remind_every INTEGER NOT NULL DEFAULT 43200;  -- segundos; 0 = no recordar
  ALTER TABLE users ADD COLUMN reminded_at INTEGER NOT NULL DEFAULT 0;       -- último recordatorio enviado
  ALTER TABLE users ADD COLUMN tz TEXT NOT NULL DEFAULT '';                  -- zona horaria del teléfono ('' = Colombia)
  `,
  // v8 · historial con nombres: las transferencias ya entregadas dicen "Para Pipe" / "De Nico" en vez de
  // "Código ABC123". Solo cambia el texto de esas filas: no toca relojes ni montos.
  `
  UPDATE ledger SET note = 'Para ' || COALESCE(NULLIF(
      (SELECT u.nickname FROM transfers t JOIN users u ON u.id = t.to_user WHERE t.ledger_id = ledger.id), ''), 'alguien')
  WHERE category = 'envio' AND id IN (SELECT ledger_id FROM transfers WHERE status = 'entregado');
  UPDATE ledger SET note = 'De ' || COALESCE(NULLIF(
      (SELECT u.nickname FROM transfers t JOIN users u ON u.id = t.from_user
       WHERE t.to_user = ledger.user_id AND 'Código ' || t.code = ledger.note), ''), 'alguien')
  WHERE category = 'recibo' AND note LIKE 'Código %';
  `,
  // v9 · idioma de la app (en/es) para los avisos push y el Guardián. Solo agrega una columna: no toca relojes.
  `
  ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT '';  -- '' = sin elegir (inglés)
  `,
  // v10 · pagos (Stripe), Tiempo Plus, ranking por elección, confianza en los ingresos y juicios del jurado.
  // Solo agrega tablas y columnas con valores por defecto: no toca relojes.
  `
  CREATE TABLE IF NOT EXISTS purchases (
    id           INTEGER PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    ref          TEXT NOT NULL UNIQUE,            -- id del pago en el proveedor: un webhook repetido no acredita dos veces
    product      TEXT NOT NULL,                   -- plus · dia · regalo · revivir
    amount       INTEGER NOT NULL DEFAULT 0,      -- en centavos
    currency     TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pagado',  -- pagado · reembolsado
    payment_ref  TEXT NOT NULL DEFAULT '',        -- payment_intent: para reembolsos y contracargos
    life_no      INTEGER,
    seconds      INTEGER NOT NULL DEFAULT 0,      -- tiempo acreditado (se descuenta si hay reembolso)
    ledger_id    INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS purchases_user ON purchases (user_id, product, created_at);
  CREATE INDEX IF NOT EXISTS purchases_payment ON purchases (payment_ref);

  CREATE TABLE IF NOT EXISTS gifts (
    code         TEXT PRIMARY KEY,
    purchase_id  INTEGER NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
    from_user    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    seconds      INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pendiente', -- pendiente · entregado · anulado
    to_user      TEXT,
    done_at      INTEGER,
    ledger_id    INTEGER
  );
  CREATE INDEX IF NOT EXISTS gifts_from ON gifts (from_user, created_at);
  CREATE INDEX IF NOT EXISTS gifts_to ON gifts (to_user, done_at);

  ALTER TABLE users ADD COLUMN plus_until INTEGER NOT NULL DEFAULT 0;      -- Plus activo hasta (ms)
  ALTER TABLE users ADD COLUMN plus_sub TEXT NOT NULL DEFAULT '';          -- id de la suscripción en el proveedor
  ALTER TABLE users ADD COLUMN plus_renews INTEGER NOT NULL DEFAULT 0;     -- 1 = se renueva sola
  ALTER TABLE users ADD COLUMN plus_revive_at INTEGER NOT NULL DEFAULT 0;  -- último Revivir gratis de Plus
  ALTER TABLE users ADD COLUMN ranked INTEGER NOT NULL DEFAULT 0;          -- 1 = eligió aparecer en el ranking
  ALTER TABLE users ADD COLUMN public_id TEXT NOT NULL DEFAULT '';         -- identificador público del ranking (nunca la llave)
  ALTER TABLE users ADD COLUMN income_trust INTEGER NOT NULL DEFAULT 0;    -- 1 = el Guardián verificó un ingreso grande con prueba
  ALTER TABLE users ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0;    -- fuera del ranking por un juicio
  CREATE INDEX IF NOT EXISTS users_plus_sub ON users (plus_sub);
  CREATE INDEX IF NOT EXISTS users_ranked ON users (ranked);
  CREATE UNIQUE INDEX IF NOT EXISTS users_public ON users (public_id) WHERE public_id <> '';

  CREATE TABLE IF NOT EXISTS trials (
    id             INTEGER PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,  -- a quién se juzga
    opened_at      INTEGER NOT NULL,
    defense_until  INTEGER NOT NULL,
    vote_until     INTEGER NOT NULL,
    defense        TEXT NOT NULL DEFAULT '',
    defended_at    INTEGER,
    status         TEXT NOT NULL DEFAULT 'abierto',  -- abierto · culpable · inocente · sin_quorum
    closed_at      INTEGER,
    guilty         INTEGER NOT NULL DEFAULT 0,
    innocent       INTEGER NOT NULL DEFAULT 0,
    penalty        INTEGER NOT NULL DEFAULT 0       -- segundos descontados si salió culpable
  );
  CREATE INDEX IF NOT EXISTS trials_user ON trials (user_id, id);
  CREATE INDEX IF NOT EXISTS trials_status ON trials (status, vote_until);

  CREATE TABLE IF NOT EXISTS accusations (
    id        INTEGER PRIMARY KEY,
    target    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    accuser   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reason    TEXT NOT NULL,          -- ingresos · imposible · cuentas · otro
    text      TEXT NOT NULL DEFAULT '',
    at        INTEGER NOT NULL,
    trial_id  INTEGER                 -- se asigna al abrir el juicio
  );
  CREATE INDEX IF NOT EXISTS accusations_target ON accusations (target, at);
  CREATE INDEX IF NOT EXISTS accusations_accuser ON accusations (accuser, at);

  CREATE TABLE IF NOT EXISTS votes (
    trial_id  INTEGER NOT NULL REFERENCES trials (id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    vote      TEXT NOT NULL,          -- culpable · inocente
    at        INTEGER NOT NULL,
    PRIMARY KEY (trial_id, user_id)
  );
  `,
  // v11 · perfil (país y "¿a qué te dedicas?"), faltas por contenido sexual y juicios de 2 días: lo que está
  // en juego, la potestad de cada citación, las pruebas de la defensa y las citaciones del Guardián.
  // Solo agrega: no toca relojes.
  `
  ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT '';       -- ISO 3166-1 alfa-2 ('' = sin elegir)
  ALTER TABLE users ADD COLUMN currency TEXT NOT NULL DEFAULT 'COP';   -- en qué ve y escribe la plata: COP o USD
  ALTER TABLE users ADD COLUMN strikes INTEGER NOT NULL DEFAULT 0;     -- faltas: nunca se borran
  ALTER TABLE trials ADD COLUMN evidence TEXT;                         -- fotos de la defensa (JSON); se borran al cerrar
  ALTER TABLE trials ADD COLUMN review TEXT;                           -- lo que el Guardián leyó en esas pruebas (JSON)
  ALTER TABLE trials ADD COLUMN stake INTEGER NOT NULL DEFAULT 0;      -- lo que está en juego (s): lo ganado sin prueba
  ALTER TABLE trials ADD COLUMN needed INTEGER NOT NULL DEFAULT 3;     -- potestad que debe sumar la citación
  ALTER TABLE trials ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;  -- 1 = pasó el día 1 y está en votación
  ALTER TABLE trials ADD COLUMN by_guardian TEXT NOT NULL DEFAULT '';  -- si lo citó el Guardián: su motivo
  ALTER TABLE accusations ADD COLUMN weight INTEGER NOT NULL DEFAULT 1; -- potestad de quien cita
  CREATE INDEX IF NOT EXISTS votes_user ON votes (user_id, at);
  CREATE TABLE IF NOT EXISTS strikes (
    id       INTEGER PRIMARY KEY,
    user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    at       INTEGER NOT NULL,
    source   TEXT NOT NULL,           -- mi_dia · perfil · acusacion · juicio
    penalty  INTEGER NOT NULL,        -- segundos descontados
    life_no  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS strikes_user ON strikes (user_id, at);
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

/** "¿A qué te dedicas?": una línea, máximo BIO_MAX caracteres visibles, sin trucos invisibles ni llaves. */
export function cleanBio(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
    .replace(/tk_[A-Za-z0-9_-]{10,}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...graphemes.segment(s)].slice(0, BIO_MAX).map((g) => g.segment).join('').trim();
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
    insertUser: st(`INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at, nickname, device_id, ip_hash, lang, country, currency)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`),
    adminUsers: st(`
      SELECT u.nickname, u.created_at, u.life_no, u.expires_at, u.device_id, u.ip_hash,
             (SELECT COUNT(*) FROM lives l WHERE l.user_id = u.id AND l.reason = 'reinicio') AS reinicios,
             (SELECT COUNT(*) FROM lives l WHERE l.user_id = u.id AND l.reason = 'muerte')   AS muertes
      FROM users u ORDER BY u.created_at DESC`),
    // sin nombre no se aparece en el ranking: borrarlo también te saca
    setNick: st(`UPDATE users SET nickname = ?1, ranked = CASE WHEN ?1 = '' THEN 0 ELSE ranked END WHERE id = ?2`),
    setLang: st('UPDATE users SET lang = ? WHERE id = ?'),
    setToken: st('UPDATE users SET token_hash = ? WHERE id = ?'),
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
    daysSince: st('SELECT COUNT(*) AS n FROM days WHERE user_id = ? AND created_at >= ?'),
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
    setNote: st('UPDATE ledger SET note = ? WHERE id = ?'),
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
      SELECT id, expires_at, alerted, lang FROM users
      WHERE expires_at <= ? AND (alerted IS NULL OR alerted > 0)
        AND EXISTS (SELECT 1 FROM push_subs s WHERE s.user_id = users.id)`),
    setAlerted: st('UPDATE users SET alerted = ? WHERE id = ?'),
    // Candidatos a recordatorio: vivos, con alertas y sin recordatorio reciente. "last" = lo último entre
    // el recordatorio anterior, el renacer y la última vez que le contó algo al Guardián.
    remindDue: st(`
      SELECT u.id, u.remind_every, u.tz, u.lang,
             MAX(u.reminded_at, u.born_at, COALESCE((SELECT MAX(d.created_at) FROM days d WHERE d.user_id = u.id), 0)) AS last
      FROM users u
      WHERE u.remind_every > 0 AND u.expires_at > ? AND u.reminded_at <= ? - u.remind_every * 1000
        AND EXISTS (SELECT 1 FROM push_subs s WHERE s.user_id = u.id)`),
    setReminded: st('UPDATE users SET reminded_at = ? WHERE id = ?'),
    setRemind: st('UPDATE users SET remind_every = ?, reminded_at = ?, tz = ? WHERE id = ?'),
    setTz: st('UPDATE users SET tz = ? WHERE id = ?'),
    getMeta: st('SELECT value FROM meta WHERE key = ?'),
    setMeta: st('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    // dinero ganado (en segundos de vida) en la ventana de los límites
    moneyUsed: st(`SELECT COALESCE(SUM(seconds), 0) AS s FROM ledger
                   WHERE user_id = ? AND at > ? AND seconds > 0 AND category IN (${sqlList(MONEY_CATS)})`),
    incomeStats: st(`SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(MAX(amount), 0) AS biggest,
                            COUNT(DISTINCT at / 86400000) AS days
                     FROM ledger WHERE user_id = ? AND category = 'ingreso' AND at > ?`),
    boughtLife: st(`SELECT COALESCE(SUM(seconds), 0) AS s FROM ledger
                    WHERE user_id = ? AND life_no = ? AND category IN (${sqlList(BOUGHT_CATS)})`),
    setTrust: st('UPDATE users SET income_trust = ? WHERE id = ?'),
    livedPast: st('SELECT COALESCE(SUM(ended_at - born_at), 0) AS ms FROM lives WHERE user_id = ?'),
    setBio: st('UPDATE users SET bio = ? WHERE id = ?'),
    setCountry: st('UPDATE users SET country = ? WHERE id = ?'),
    setCurrency: st('UPDATE users SET currency = ? WHERE id = ?'),
    setStrikes: st('UPDATE users SET strikes = ? WHERE id = ?'),
    addStrike: st('INSERT INTO strikes (user_id, at, source, penalty, life_no) VALUES (?, ?, ?, ?, ?)'),
    adminStrikes: st('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS people FROM strikes'),
    giftGet: st('SELECT * FROM gifts WHERE code = ?'),
    adminSales: st(`SELECT product, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS cents FROM purchases
                    WHERE status = 'pagado' GROUP BY product`),
    adminTrials: st('SELECT status, COUNT(*) AS n FROM trials GROUP BY status'),
    adminRanked: st('SELECT COUNT(*) AS n FROM users WHERE ranked = 1'),
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
    if (!u) throw new AppError(401, 'auth', 'Llave inválida', 'Invalid key');
    return u;
  }

  // Los módulos de pagos y de ranking/juicios se enganchan aquí (se definen al final de openStore).
  const hooks = {};

  const isPlus = (u, t) => u.plus_until > t;
  const perDay = (u, t) => (isPlus(u, t) ? PLUS.daysPerDay : DAYS_PER_DAY);
  const repliesOf = (u, t) => (isPlus(u, t) ? PLUS.replies : MAX_REPLIES);

  /** Charlas con el Guardián: cuántas usó hoy (fecha en su zona) y cuándo se renuevan. */
  function dayQuota(u, t) {
    const from = startOfLocalDay(t, u.tz);
    const used = q.daysSince.get(u.id, from).n;
    // Un día dura entre 23 y 25 h: 30 h después de esta medianoche siempre es mañana.
    return { used, left: Math.max(0, perDay(u, t) - used), resetAt: startOfLocalDay(from + 30 * 3_600_000, u.tz) };
  }

  /**
   * Cuánto ha ganado por dinero (segundos de vida) en la ventana semanal y cuánto le cabe:
   * word = en su palabra (sube al tope cuando el Guardián verificó un ingreso grande), cap = tope para todos.
   */
  function moneyState(u, t) {
    const used = q.moneyUsed.get(u.id, t - MONEY.windowDays * DAY_MS).s;
    const cap = MONEY.capDays * DAY_S;
    return { used, word: u.income_trust ? cap : MONEY.wordDays * DAY_S, cap, verified: Boolean(u.income_trust) };
  }

  /** Tiempo vivido de verdad: todas sus vidas, sin los ratos con el reloj en cero. Da la potestad de citar a juicio. */
  function livedSeconds(u, t) {
    const past = q.livedPast.get(u.id).ms;
    const current = Math.max(0, Math.min(t, u.expires_at) - u.born_at);
    return Math.floor((past + current) / 1000);
  }

  /**
   * Falta por subir contenido sexual: 1 día, luego 1 semana, 1 mes, 3 meses, 1 año. Nunca se borran
   * (ni al renacer) y no hay piso: si no le alcanza, se queda en cero. Va dentro de una transacción.
   */
  function applyStrike(u, source, t) {
    const n = u.strikes;
    const penalty = strikeSeconds(n);
    let taken = 0;
    if (u.expires_at > t) {
      const expires = Math.max(t, u.expires_at - penalty * 1000);
      taken = Math.round((u.expires_at - expires) / 1000);
      q.addTx.run(u.id, u.life_no, t, -taken, `Falta ${n + 1}`, 'sancion', taken, 'sancion');
      q.setExpiry.run(expires, alertBand(expires - t), u.id);
    }
    q.addStrike.run(u.id, t, source, taken, u.life_no);
    q.setStrikes.run(n + 1, u.id);
    return { n: n + 1, penalty: taken, next: strikeSeconds(n + 1) };
  }

  /** El error que ve quien subió contenido prohibido (lo que perdió y lo que le costará la próxima). */
  function strikeError(s) {
    const lost = (lang) => (s.penalty ? (lang === 'en' ? ` You lost ${daysText(s.penalty, 'en')} of life.` : ` Perdiste ${daysText(s.penalty, 'es')} de vida.`) : '');
    const e = new AppError(
      422,
      'explicit',
      `Eso es contenido sexual y está prohibido en Tiempo.${lost('es')} Si vuelve a pasar, perderás ${daysText(s.next, 'es')}.`,
      `That's sexual content and it's forbidden in Tiempo.${lost('en')} If it happens again, you'll lose ${daysText(s.next, 'en')}.`,
    );
    e.strike = s;
    return e;
  }

  function snapshot(u) {
    const totals = q.totals.get(u.id, u.life_no);
    const t = now();
    const quota = dayQuota(u, t);
    const money = moneyState(u, t);
    const bought = q.boughtLife.get(u.id, u.life_no).s;
    const remaining = Math.max(0, Math.floor((u.expires_at - t) / 1000));
    return {
      now: t,
      nickname: u.nickname,
      remindEvery: u.remind_every,
      daysPerDay: perDay(u, t),
      daysLeft: quota.left,
      daysResetAt: quota.resetAt,
      maxReplies: repliesOf(u, t),
      lifeNo: u.life_no,
      bornAt: u.born_at,
      expiresAt: u.expires_at,
      initialSeconds,
      earned: totals.earned,
      spent: totals.spent,
      record: q.record.get(u.id).ms ?? 0,
      ledger: q.ledger.all(u.id, u.life_no).map((r) => ({ ...r })),
      plus: {
        active: isPlus(u, t),
        until: u.plus_until,
        renews: Boolean(u.plus_renews),
        freeRevive: isPlus(u, t) && t - u.plus_revive_at >= PLUS.reviveEvery,
      },
      money: { ...money, windowDays: MONEY.windowDays },
      bio: u.bio,
      country: u.country,
      currency: u.currency,
      lived: livedSeconds(u, t),
      strikes: u.strikes,
      nextStrike: strikeSeconds(u.strikes),
      ranked: Boolean(u.ranked),
      publicId: u.public_id,
      bannedUntil: u.banned_until > t ? u.banned_until : 0,
      // la liga se mide con el tiempo que te queda sin contar lo comprado
      league: leagueOf(Math.max(0, remaining - bought)),
      trial: hooks.myTrial?.(u, t) ?? null,
      jury: hooks.juryCount?.(u, t) ?? 0,
    };
  }

  /* ───────── Mi día: utilidades ───────── */

  function cleanImages(images, already) {
    if (images == null) return [];
    if (!Array.isArray(images)) throw new AppError(400, 'images', 'Fotos inválidas', 'Invalid photos');
    if (images.length > PHOTOS_PER_MSG || already + images.length > PHOTOS_PER_DAY) {
      throw new AppError(400, 'images', `Máximo ${PHOTOS_PER_MSG} fotos por mensaje y ${PHOTOS_PER_DAY} por día`, `Up to ${PHOTOS_PER_MSG} photos per message and ${PHOTOS_PER_DAY} per day`);
    }
    return images.map((im) => {
      const ok =
        im && MEDIA.has(im.media_type) && typeof im.data === 'string' &&
        im.data.length > 100 && im.data.length <= PHOTO_MAX_B64 && /^[A-Za-z0-9+/]+=*$/.test(im.data);
      if (!ok) throw new AppError(400, 'images', 'Foto inválida o demasiado grande', 'Invalid or too large photo');
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
    if (!row) throw new AppError(404, 'not_found', 'Ese día no existe', "That day doesn't exist");
    const day = loadDay(row);
    if (day.status !== 'abierto') throw new AppError(409, 'closed', 'Ese día ya se cerró', 'That day is already closed');
    return day;
  }

  function saveDay(day) {
    q.daySave.run(JSON.stringify(day.turns), JSON.stringify(day.images), day.verdict && JSON.stringify(day.verdict), day.rounds, day.id);
  }

  /**
   * Lo que la IA devolvió, saneado: nunca confiamos en su forma ni en sus números.
   * proof (una foto respalda el ítem) solo vale si en la conversación hay fotos de verdad.
   */
  function cleanVerdict(v, hasPhotos) {
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
        proof: Boolean(valid && hasPhotos && it?.proof === true),
      };
    });
    // explicit: alguna foto es contenido sexual. Sin fotos no puede haberlo (el texto no cuenta aquí).
    // summon: el Guardián cree que los demás jugadores deben juzgarlo; summonReason es lo que verá el jurado.
    return {
      message: String(v?.message ?? '').slice(0, 600),
      items,
      explicit: Boolean(hasPhotos && v?.explicit === true),
      summon: v?.summon === true,
      summonReason: v?.summon === true ? String(v?.summon_reason ?? '').slice(0, 200) : '',
    };
  }

  /**
   * Tiempo de vida de cada ítem aprobado, con los límites que hacen creíble un día:
   * - horas: el tope de cada categoría y, entre todas, máximo HOURS_PER_DAY en 24 h;
   * - dinero: en su palabra hasta money.word por semana; con prueba (foto), hasta money.cap, el tope para todos.
   * capped + limit ('cap' | 'proof') dicen por qué se recortó: 'proof' = el resto entra si trae prueba.
   */
  function priceItems(u, items, t) {
    const used = {};
    const hoursUsed = (cat) => (used[cat] ??= q.usedSince.get(u.id, cat, t - CAP_WINDOW).used);
    let hoursTotal = null;
    const money = moneyState(u, t);
    let moneyUsed = money.used;
    return items.map((it) => {
      const c = CATEGORIES[it.category];
      if (it.verdict !== 'aprobado' || !c || c.system || !(it.amount > 0)) return { ...it, seconds: 0 };
      let amount = it.amount;
      let capped = false;
      let limit = null;
      if (c.unit === 'hours') {
        hoursTotal ??= HOUR_CATS.reduce((s, k) => s + hoursUsed(k), 0);
        const room = Math.max(0, Math.min((c.cap ?? HOURS_PER_DAY) - hoursUsed(it.category), HOURS_PER_DAY - hoursTotal));
        if (amount > room) (amount = Math.floor(room * 100) / 100), (capped = true), (limit = 'cap');
        used[it.category] += amount;
        hoursTotal += amount;
      }
      if (MONEY_CATS.includes(it.category)) {
        const room = Math.max(0, (it.proof ? money.cap : money.word) - moneyUsed);
        if (lifeSeconds(it.category, amount, minWage) > room) {
          const perPeso = lifeSeconds(it.category, 1_000_000, minWage) / 1_000_000;
          amount = Math.floor(room / perPeso);
          capped = true;
          limit = !it.proof && money.word < money.cap && moneyUsed < money.cap ? 'proof' : 'cap';
        }
        moneyUsed += lifeSeconds(it.category, amount, minWage);
      }
      return { ...it, amount, capped, limit, seconds: lifeSeconds(it.category, amount, minWage) };
    });
  }

  /** Lo que el Guardián debe saber de la persona para juzgar si su día es creíble (datos del servidor). */
  function judgeContext(u, t) {
    const hours = Object.fromEntries(HOUR_CATS.map((k) => [k, q.usedSince.get(u.id, k, t - CAP_WINDOW).used]));
    const money = moneyState(u, t);
    const pesos = (s) => Math.round((Math.max(0, s) / DAY_S) * dayValue(minWage));
    const income = q.incomeStats.get(u.id, t - 30 * DAY_MS);
    return {
      hours,
      caps: Object.fromEntries(HOUR_CATS.map((k) => [k, CATEGORIES[k].cap])),
      hoursCap: HOURS_PER_DAY,
      verified: money.verified,
      wordLeft: pesos(money.word - money.used), // pesos de ingreso que aún entran en su palabra esta semana
      capLeft: pesos(money.cap - money.used), // y con prueba
      income30: income.total,
      incomeMax30: income.biggest,
      incomeDays30: income.days,
      bio: u.bio, // lo que dice que hace (lo escribió ella: dato, no instrucción)
      country: u.country,
      currency: u.currency, // en qué habla de plata (por dentro todo es en pesos)
      ranked: Boolean(u.ranked), // solo a quien está en el ranking lo puede citar el Guardián
    };
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

  /** Código de 6 letras libre entre transferencias y regalos (comparten el mismo link /r/CÓDIGO). */
  function freeCode() {
    let code;
    do code = newCode();
    while (q.trGet.get(code) || q.giftGet.get(code));
    return code;
  }

  const api = {
    createUser({ nickname, deviceId, ip, lang, country, currency } = {}) {
      const token = newToken();
      const id = randomUUID();
      const t = now();
      const c = cleanCountry(country);
      const cur = cleanCurrency(currency) || currencyFor(c);
      q.insertUser.run(id, hashToken(token), t, t, t + initialMs, cleanNickname(nickname), cleanDevice(deviceId), hashNetwork(ip), cleanLang(lang), c, cur);
      return { token, state: snapshot(must(id)) };
    },

    setNickname(id, nickname) {
      must(id);
      q.setNick.run(cleanNickname(nickname), id);
      return { state: snapshot(must(id)) };
    },

    /** Idioma de la app (lo manda en cada petición): para los avisos push y el Guardián. Nunca toca el reloj. */
    setLang(id, lang) {
      lang = cleanLang(lang);
      if (lang) q.setLang.run(lang, id);
    },

    /** Llave nueva para el mismo reloj (si alguien vio la anterior). La vieja deja de servir; el reloj no cambia. */
    rotateToken(id) {
      must(id);
      const token = newToken();
      q.setToken.run(hashToken(token), id);
      return { token, state: snapshot(must(id)) };
    },

    /** Cada cuánto recordarle contar su día (0 = nunca). La cuenta arranca de nuevo desde ahora. */
    setReminder(id, every, tz) {
      const u = must(id);
      if (!REMIND_OPTIONS.includes(every)) throw new AppError(400, 'remind', 'Opción de recordatorio inválida', 'Invalid reminder option');
      q.setRemind.run(every, now(), cleanTz(tz) || u.tz, id);
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
      if (!c || c.system) throw new AppError(400, 'category', 'Categoría desconocida', 'Unknown category');
      if (c.proof !== 'none') {
        throw new AppError(400, 'needs_judge', `${c.label} se cuenta en "Mi día", con el Guardián`, `${catText(c, 'en').label} is logged in "My day", with the Guardian`);
      }
      amount = Number(amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT[c.unit]) {
        throw new AppError(400, 'amount', 'Cantidad inválida', 'Invalid amount');
      }
      amount = c.unit === 'money' ? Math.round(amount) : Math.round(amount * 100) / 100;
      const seconds = lifeSeconds(category, amount, minWage);
      if (!seconds || Math.abs(seconds) > MAX_TX) throw new AppError(400, 'amount', 'Cantidad inválida', 'Invalid amount');
      note = typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '';

      return tx(() => {
        const u = must(id);
        const t = now();
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó', 'Your time ran out');
        if (c.cap) {
          const { used } = q.usedSince.get(u.id, category, t - CAP_WINDOW);
          if (used + amount > c.cap + 1e-9) {
            throw new AppError(409, 'cap', `Máximo ${c.cap} h de ${c.label.toLowerCase()} cada 24 horas`, `Up to ${c.cap} h of ${catText(c, 'en').label.toLowerCase()} every 24 hours`);
          }
        }
        if (MONEY_CATS.includes(category)) {
          const m = moneyState(u, t);
          const left = Math.max(0, m.word - m.used);
          if (m.used + seconds > m.word) {
            if (m.word >= m.cap) {
              throw new AppError(
                409,
                'money_cap',
                `El dinero suma máximo ${MONEY.capDays} días de vida por semana, para todos. Esta semana te quedan ${daysText(left, 'es')}.`,
                `Money adds at most ${MONEY.capDays} days of life per week, for everyone. You have ${daysText(left, 'en')} left this week.`,
              );
            }
            throw new AppError(
              409,
              'money_word',
              `En tu palabra, el dinero suma hasta ${MONEY.wordDays} días de vida por semana (te quedan ${daysText(left, 'es')}). Para más, cuéntaselo al Guardián en "Mi día" con una prueba del pago.`,
              `On your word, money adds up to ${MONEY.wordDays} days of life per week (${daysText(left, 'en')} left). For more, tell the Guardian in "My day" with proof of payment.`,
            );
          }
        }
        const expires = u.expires_at + seconds * 1000;
        if (expires <= t) throw new AppError(409, 'insufficient', 'No te alcanza el tiempo', "You don't have enough time");
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
        if (!row || row.life_no !== u.life_no) throw new AppError(404, 'not_found', 'Ese movimiento ya no existe', 'That entry no longer exists');
        if (CATEGORIES[row.category]?.system) throw new AppError(409, 'system', 'Las transferencias no se deshacen', "Transfers can't be undone");
        if (t - row.at > UNDO_WINDOW) throw new AppError(409, 'too_late', 'Ya no se puede deshacer', "It can't be undone anymore");
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó', 'Your time ran out');
        const expires = u.expires_at - row.seconds * 1000;
        if (expires <= t) throw new AppError(409, 'insufficient', 'Deshacerlo te dejaría en cero', 'Undoing it would leave you at zero');
        q.delTx.run(row.id);
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        return { state: snapshot(must(id)) };
      });
    },

    rebirth(id, force = false) {
      return tx(() => {
        const u = must(id);
        const t = now();
        if (u.expires_at > t && !force) throw new AppError(409, 'alive', 'Aún tienes tiempo', 'You still have time');
        // ¿Se le acabó el tiempo o reinició teniendo tiempo? Sirve para ver quién aprovecha las vidas.
        const reason = u.expires_at > t ? 'reinicio' : 'muerte';
        q.endLife.run(u.id, u.life_no, u.born_at, Math.min(u.expires_at, t), reason);
        q.newLife.run(t, t + initialMs, u.id);
        return { state: snapshot(must(id)) };
      });
    },

    /* ───────── Mi día ───────── */

    openDay(id, { text, images, tz } = {}) {
      let u = must(id);
      const t = now();
      if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó', 'Your time ran out');
      // "Hoy" es la fecha del teléfono: la zona llega con cada charla (si viajó, se actualiza).
      tz = cleanTz(tz);
      if (tz && tz !== u.tz) q.setTz.run(tz, id), (u = must(id));
      if (dayQuota(u, t).left <= 0) {
        const n = perDay(u, t);
        throw new AppError(
          429,
          'days',
          `Ya usaste tus ${n} charlas de hoy con el Guardián. Se renuevan a medianoche.`,
          `You've used your ${n} chats with the Guardian for today. They reset at midnight.`,
        );
      }
      text = typeof text === 'string' ? text.trim().slice(0, DAY_TEXT_MAX) : '';
      if (!text) throw new AppError(400, 'text', 'Cuéntale al Guardián qué hiciste', 'Tell the Guardian what you did');
      const imgs = cleanImages(images, 0);
      const turns = [{ role: 'user', text, photos: imgs.length }];
      const r = q.dayInsert.run(id, t, JSON.stringify(turns), JSON.stringify(imgs));
      return { id: Number(r.lastInsertRowid) };
    },

    replyDay(id, dayId, { text, images } = {}) {
      const day = openDayOf(id, dayId);
      if (day.turns.at(-1)?.role !== 'judge') throw new AppError(409, 'waiting', 'Espera el veredicto', 'Wait for the verdict');
      if (day.rounds >= repliesOf(must(id), now())) throw new AppError(409, 'final', 'El Guardián ya tomó su decisión final', 'The Guardian has made its final decision');
      text = typeof text === 'string' ? text.trim().slice(0, DAY_TEXT_MAX) : '';
      const imgs = cleanImages(images, day.images.length);
      if (!text && !imgs.length) throw new AppError(400, 'text', 'Escribe tu réplica o sube una prueba', 'Write your reply or upload proof');
      day.turns.push({ role: 'user', text, photos: imgs.length });
      day.images.push(...imgs);
      day.rounds += 1;
      saveDay(day);
    },

    /** Lo que se le manda a la IA: conversación + fotos, marcando las que ya se usaron como prueba. */
    judgeInput(id, dayId) {
      const day = openDayOf(id, dayId);
      const u = must(id);
      const t = now();
      return {
        turns: day.turns,
        images: day.images.map((im) => ({ ...im, reused: Boolean(q.hashUsed.get(im.hash)) })),
        now: t,
        lang: u.lang || 'en',
        plus: isPlus(u, t), // Plus: el Guardián más fino
        maxReplies: repliesOf(u, t),
        context: judgeContext(u, t),
      };
    },

    /** Guarda el veredicto. Si alguna foto era contenido sexual: falta inmediata, las fotos se borran y nada se prueba con ellas. */
    saveVerdict(dayId, verdict) {
      return tx(() => {
        const day = loadDay(q.dayById.get(dayId));
        const clean = cleanVerdict(verdict, day.images.length > 0);
        let strike = null;
        if (clean.explicit) {
          strike = applyStrike(must(day.userId), 'mi_dia', now());
          day.images = [];
          for (const it of clean.items) {
            it.proof = false;
            if (CATEGORIES[it.category]?.proof === 'photo' && it.verdict === 'aprobado') it.verdict = 'rechazado';
          }
        }
        day.turns.push({ role: 'judge', verdict: clean });
        day.verdict = clean;
        saveDay(day);
        return { strike };
      });
    },

    /** País (obligatorio al registrarse en la app nueva; quien venía de antes lo elige en Ajustes). */
    setCountry(id, country) {
      must(id);
      const c = cleanCountry(country);
      if (!c) throw new AppError(400, 'country', 'Elige tu país', 'Choose your country');
      q.setCountry.run(c, id);
      return { state: snapshot(must(id)) };
    },

    /** En qué moneda ve y escribe la plata: COP o USD. Nunca cambia el reloj ni lo ya contado. */
    setCurrency(id, currency) {
      must(id);
      const c = cleanCurrency(currency);
      if (!c) throw new AppError(400, 'currency', 'Moneda inválida', 'Invalid currency');
      q.setCurrency.run(c, id);
      return { state: snapshot(must(id)) };
    },

    /** "¿A qué te dedicas?" (ya revisado por el Guardián). Vacío lo borra. */
    setBio(id, bio) {
      must(id);
      q.setBio.run(cleanBio(bio), id);
      return { state: snapshot(must(id)) };
    },

    /** Falta por contenido sexual (perfil, acusación o pruebas): descuenta y devuelve el error que ve la persona. */
    explicitStrike(id, source) {
      return strikeError(tx(() => applyStrike(must(id), source, now())));
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
      if (!row) throw new AppError(404, 'not_found', 'Ese día no existe', "That day doesn't exist");
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
        maxReplies: repliesOf(u, t),
        turns,
        net: last ? last.items.reduce((s, it) => s + it.seconds, 0) : 0,
      };
    },

    acceptDay(id, dayId) {
      return tx(() => {
        const day = openDayOf(id, dayId);
        if (!day.verdict) throw new AppError(409, 'waiting', 'Aún no hay veredicto', 'No verdict yet');
        const u = must(id);
        const t = now();
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó', 'Your time ran out');
        const items = priceItems(u, day.verdict.items, t).filter((it) => it.seconds);
        let expires = u.expires_at;
        for (const it of items) {
          const status = CATEGORIES[it.category].proof === 'photo' || it.proof ? 'verificado' : 'aprobado';
          q.addTx.run(u.id, u.life_no, t, it.seconds, it.activity, it.category, it.amount, status);
          expires += it.seconds * 1000;
        }
        if (expires <= t) expires = t; // gastó más de lo que tenía: se acabó
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        for (const im of day.images) q.hashAdd.run(im.hash, u.id, t); // una foto prueba una sola vez
        q.dayClose.run('aceptado', day.id);
        // El Guardián confirmó con prueba un ingreso grande (al menos lo que entra en su palabra en una semana):
        // desde ahora le cree hasta el tope. Un jurado que lo declare culpable se lo quita.
        const trusted =
          !u.income_trust && items.some((it) => MONEY_CATS.includes(it.category) && it.proof && it.seconds >= MONEY.wordDays * DAY_S);
        if (trusted) q.setTrust.run(1, u.id);
        // El Guardián lo cita a juicio (solo si está en el ranking): al aceptar, lo de hoy ya cuenta en lo que está en juego.
        const summoned = day.verdict.summon ? Boolean(hooks.guardianSummon?.(must(id), day.verdict.summonReason, t)) : false;
        return { net: items.reduce((s, it) => s + it.seconds, 0), trusted, summoned, state: snapshot(must(id)) };
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
        throw new AppError(400, 'amount', 'Cantidad inválida (mínimo 1 minuto)', 'Invalid amount (minimum 1 minute)');
      }
      return tx(() => {
        const u = must(id);
        const t = now();
        if (u.expires_at <= t) throw new AppError(409, 'dead', 'Tu tiempo se agotó', 'Your time ran out');
        if (q.trPending.get(id).n >= MAX_PENDING) throw new AppError(429, 'pending', `Ya tienes ${MAX_PENDING} códigos activos`, `You already have ${MAX_PENDING} active codes`);
        const expires = u.expires_at - seconds * 1000;
        if (expires - t < KEEP_MS) throw new AppError(409, 'insufficient', 'No puedes regalar todo tu tiempo', "You can't give away all your time");
        const code = freeCode();
        const r = q.addTx.run(u.id, u.life_no, t, -seconds, `Código ${code}`, 'envio', seconds, 'enviado');
        q.trInsert.run(code, u.id, seconds, t, t + TRANSFER_TTL, Number(r.lastInsertRowid));
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        return { transfer: { code, seconds, expiresAt: t + TRANSFER_TTL }, state: snapshot(must(id)) };
      });
    },

    claimTransfer(id, rawCode) {
      const code = normalizeCode(rawCode);
      if (!/^[A-Z2-9]{6}$/.test(code)) throw new AppError(400, 'code', 'Código inválido', 'Invalid code');
      const result = tx(() => {
        const u = must(id);
        const t = now();
        const tr = q.trGet.get(code);
        if (!tr) {
          // ¿Es un regalo comprado? Usa el mismo código de 6 letras y el mismo link /r/CÓDIGO.
          const gift = hooks.claimGift?.(u, code, t);
          if (gift?.error) return gift;
          if (gift) return { ...gift, state: snapshot(must(id)) };
        }
        if (!tr || tr.status !== 'pendiente') return { error: new AppError(404, 'code', 'Código inválido o ya usado', 'Invalid or already used code') };
        if (tr.expires_at <= t) {
          refund(tr, t); // se guarda la devolución y luego se avisa del error
          return { error: new AppError(410, 'expired', 'Ese código ya expiró', 'That code has expired') };
        }
        if (tr.from_user === u.id) return { error: new AppError(409, 'own', 'Ese código es tuyo', 'That code is yours') };
        if (u.expires_at <= t) return { error: new AppError(409, 'dead', 'Tu reloj está en cero: renace primero', 'Your clock is at zero: be reborn first') };
        // En el historial de cada uno queda con quién fue: "De Nico" / "Para Pipe".
        const fromName = q.byId.get(tr.from_user)?.nickname || '';
        q.addTx.run(u.id, u.life_no, t, tr.seconds, `De ${fromName || 'alguien'}`, 'recibo', tr.seconds, 'recibido');
        q.setNote.run(`Para ${u.nickname || 'alguien'}`, tr.ledger_id);
        const expires = u.expires_at + tr.seconds * 1000;
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
        q.trSet.run('entregado', u.id, t, code);
        const fromLang = q.byId.get(tr.from_user)?.lang || 'en';
        return { seconds: tr.seconds, fromUser: tr.from_user, fromName, fromLang, toName: u.nickname, state: snapshot(must(id)) };
      });
      if (result.error) throw result.error;
      return result;
    },

    cancelTransfer(id, rawCode) {
      return tx(() => {
        const tr = q.trGet.get(normalizeCode(rawCode));
        if (!tr || tr.from_user !== id) throw new AppError(404, 'code', 'Ese código no existe', "That code doesn't exist");
        if (tr.status !== 'pendiente') throw new AppError(409, 'done', 'Ese código ya se usó', 'That code was already used');
        refund(tr, now());
        return { state: snapshot(must(id)) };
      });
    },

    transferStatus(id, rawCode) {
      const tr = q.trGet.get(normalizeCode(rawCode));
      if (!tr || tr.from_user !== id) throw new AppError(404, 'code', 'Ese código no existe', "That code doesn't exist");
      const toName = tr.to_user ? q.byId.get(tr.to_user)?.nickname || '' : '';
      return { code: tr.code, status: tr.status, seconds: tr.seconds, expiresAt: tr.expires_at, toName };
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
        throw new AppError(400, 'subscription', 'Suscripción inválida', 'Invalid subscription');
      }
      q.upsertSub.run(endpoint, id, keys.p256dh, keys.auth, now());
      q.trimSubs.run(id, id);
      const tz = cleanTz(sub.tz);
      if (tz) q.setTz.run(tz, id); // para no recordarle nada de noche en su hora
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
          out.push({ userId: u.id, band, expiresAt: u.expires_at, lang: u.lang || 'en' });
        }
        return out;
      });
    },

    /**
     * Marca y devuelve los recordatorios de "Mi día" que tocan ahora: a quien lleva su intervalo sin
     * contarle nada al Guardián (ni recibir recordatorio), solo de día en su hora. Nunca toca relojes.
     */
    claimReminders(t = now()) {
      return tx(() => {
        const out = [];
        for (const u of q.remindDue.all(t, t)) {
          if (t - u.last < u.remind_every * 1000) continue;
          const hour = localHour(t, u.tz);
          if (hour >= QUIET_FROM || hour < QUIET_TO) continue; // de noche espera a la mañana
          q.setReminded.run(t, u.id);
          out.push({ userId: u.id, hour, lang: u.lang || 'en' });
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
        ventas: q.adminSales.all().map((r) => ({ producto: r.product, cantidad: r.n, usd: r.cents / 100 })),
        juicios: Object.fromEntries(q.adminTrials.all().map((r) => [r.status, r.n])),
        enRanking: q.adminRanked.get().n,
        faltas: { total: q.adminStrikes.get().n, personas: q.adminStrikes.get().people },
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

  // Pagos (Revivir, +1 día, regalos, Plus) y ranking con juicios: comparten la base y las utilidades de aquí.
  const ctx = { st, q, tx, must, now, snapshot, hooks, freeCode, alertBand, AppError, isPlus, PLUS, minWage, initialSeconds, livedSeconds, cleanImages, startOfLocalDay };
  return Object.assign(api, payStore(ctx), socialStore(ctx));
}
