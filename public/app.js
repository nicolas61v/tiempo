import { Clock } from './clock.js';
import { CATEGORIES, lifeSeconds, dayValue, catText } from './economy.js';
import { T, LANG, LOCALE, saveLang, translatePage } from './i18n.js';
import qrcode from './vendor/qrcode.mjs';
import { canScan, startScan } from './scan.js';

const $ = (sel) => document.querySelector(sel);
const DAY = 86_400, HOUR = 3_600, MIN = 60, WEEK = 7 * DAY;
const STORE_KEY = 'tiempo.v1';
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;
const INITIAL = Number(meta('initial-seconds')) || WEEK;
const MIN_WAGE = Number(meta('min-wage')) || 1_750_905;
const DAYS_PER_DAY = Number(meta('days-per-day')) || 7; // charlas con el Guardián por fecha
const DAY_VALUE = dayValue(MIN_WAGE);
const VERSION = meta('app-version') || 'dev';
// A mano solo entra lo que va "en tu palabra"; lo demás pasa por el Guardián.
const ORDER = { earn: ['ingreso', 'inversion'], spend: ['consumo'] };
const CHIPS = { money: [5_000, 20_000, 50_000, 100_000, 500_000, 1_000_000], hours: [0.25, 0.5, 1, 2, 4, 8] };
const MAX_AMOUNT = { money: 10_000_000_000, hours: 24 };
const SHARE_CHIPS = [300, 900, 3_600, 21_600, DAY, WEEK];
// La economía es en pesos colombianos (1 día = salario mínimo de Colombia), en cualquier idioma.
const cop = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'COP', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat(LOCALE);
const cText = (c) => catText(c, LANG);

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ───────── estado ───────── */

const saved = readSaved(); // { token, state, offset, recent2, day, share }
let S = saved.token ? saved.state || null : null; // última foto del servidor
let offset = saved.offset || 0; // hora del servidor − hora del teléfono
let synced = false;
let lastSync = 0;
const now = () => Date.now() + offset;

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function persist() {
  saved.state = S;
  saved.offset = offset;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {}
}

/**
 * Identificador anónimo de este teléfono (aleatorio, no dice nada de la persona). Vive aparte del reloj:
 * sirve para saber si en un mismo teléfono se crean varias cuentas.
 */
function deviceId() {
  try {
    let id = localStorage.getItem('tiempo.device');
    if (!id) {
      id = crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('tiempo.device', id);
    }
    return id;
  } catch {
    return '';
  }
}

// Tocar el recordatorio de "Mi día" abre la app en /#dia: se va directo a contarle al Guardián.
let dayOnLoad = location.hash === '#dia';
if (dayOnLoad) history.replaceState(null, '', location.pathname);

// Link de regalo: /r/CÓDIGO (lo abre la cámara del celular al escanear el QR)
let giftCode = null;
const deep = /^\/r\/([A-Za-z0-9]{6})\/?$/.exec(location.pathname);
if (deep) {
  giftCode = deep[1].toUpperCase();
  history.replaceState(null, '', '/');
}

/* ───────── formato ───────── */

function fmtDur(sec, max = 2) {
  sec = Math.floor(Math.abs(sec));
  if (sec < 60) return sec ? `${sec}s` : '0m';
  const out = [];
  for (const [unit, n] of [['d', DAY], ['h', HOUR], ['m', MIN]]) {
    const v = Math.floor(sec / n);
    sec -= v * n;
    if (v) out.push(v + unit);
    if (out.length === max) break;
  }
  return out.join(' ');
}
function fmtLong(sec) {
  for (const [n, unit] of [[WEEK, 'unit.week'], [DAY, 'unit.day'], [HOUR, 'unit.hour']]) {
    const v = sec / n;
    if (Number.isInteger(v)) return T(unit, { n: v });
  }
  return fmtDur(sec, 3);
}
function amountOf(category, amount) {
  const unit = CATEGORIES[category]?.unit;
  return unit === 'money' ? cop.format(amount) : unit === 'seconds' ? fmtDur(amount, 3) : fmtDur(amount * HOUR);
}
const labelOf = (x) => (CATEGORIES[x.category] ? cText(CATEGORIES[x.category]).label : T(x.seconds > 0 ? 'earned' : 'spent'));
function detailOf(x) {
  const c = CATEGORIES[x.category];
  if (!c) return '';
  const seal = x.status === 'verificado' ? T('seal.photo') : x.status === 'aprobado' ? T('seal.judge') : '';
  return `${cText(c).label} · ${amountOf(x.category, x.amount)}${seal}`;
}
/** Las notas de transferencias las escribe el servidor en español ("De Nico", "Para Pipe", "Código ABC123"). */
function noteOf(x) {
  const note = x.note || '';
  if (LANG === 'es' || !CATEGORIES[x.category]?.system) return note;
  const who = (n) => (n === 'alguien' ? '' : n);
  let m;
  if ((m = /^Para (.*)$/s.exec(note))) return T('note.to', { name: who(m[1]) });
  if ((m = /^De (.*)$/s.exec(note))) return T('note.from', { name: who(m[1]) });
  if ((m = /^Código (\w+)$/.exec(note))) return T('note.code', { code: m[1] });
  return note;
}
// Fechas: 'es' a secas (24 h, como siempre) o 'en' (inglés de EE. UU.).
const dtDate = new Intl.DateTimeFormat(LANG, { weekday: 'long', day: 'numeric', month: 'long' });
const dtTime = new Intl.DateTimeFormat(LANG, { hour: '2-digit', minute: '2-digit' });
const dtDay = new Intl.DateTimeFormat(LANG, { weekday: 'long', day: 'numeric', month: 'short' });
const rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto', style: 'short' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function rel(ts) {
  const s = Math.round((ts - now()) / 1000);
  const a = Math.abs(s);
  if (a < MIN) return T('now');
  if (a < HOUR) return rtf.format(Math.round(s / MIN), 'minute');
  if (a < DAY) return rtf.format(Math.round(s / HOUR), 'hour');
  return rtf.format(Math.round(s / DAY), 'day');
}
function dayLabel(ts) {
  const d = new Date(ts).toDateString();
  const today = new Date();
  if (d === today.toDateString()) return T('today');
  today.setDate(today.getDate() - 1);
  if (d === today.toDateString()) return T('yesterday');
  return cap(dtDay.format(ts));
}
const signed = (s) => `${s > 0 ? '+' : '−'}${fmtDur(s, 3)}`;
const vibrate = (p) => {
  try {
    navigator.vibrate?.(p);
  } catch {}
};
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function button(text, data) {
  const b = el('button', null, text);
  b.type = 'button';
  Object.assign(b.dataset, data);
  return b;
}

/* ───────── red ───────── */

async function api(method, path, body) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: {
        ...(body && { 'Content-Type': 'application/json' }),
        ...(saved.token && { Authorization: `Bearer ${saved.token}` }),
        'X-Lang': LANG, // el servidor responde errores, avisos y al Guardián en este idioma
      },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error(T('net.offline')), { offline: true });
  }
  const mid = (t0 + Date.now()) / 2;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || T('net.failed')), { status: res.status, code: data.error });
  const snap = data.state || (data.expiresAt && data.lifeNo ? data : null);
  if (snap?.now) {
    // Corrige la hora del teléfono, sin saltos por ruido de red.
    const o = snap.now - mid;
    if (!synced || Math.abs(o - offset) > 1000) offset = o;
    synced = true;
  }
  return data;
}

function apply(state) {
  S = state;
  lastSync = Date.now();
  persist();
  render();
}

/* ───────── pantalla principal ───────── */

const clock = new Clock($('#clock'), { units: T('clock.units'), ariaLabel: (parts) => T('clock.left', parts) });
let timer = 0;
let lastMinute = -1;
const moodFor = (rem) => (rem <= 0 ? 'dead' : rem <= HOUR * 1000 ? 'critical' : rem <= DAY * 1000 ? 'low' : 'ok');

function renderIntro() {
  clearTimeout(timer);
  document.body.dataset.phase = 'intro';
  document.body.dataset.mood = 'ok';
  clock.set(INITIAL * 1000);
  $('#status').textContent = T('status.intro');
  $('#life').textContent = '';
  $('#intro-initial').textContent = fmtLong(INITIAL);
  const gift = $('#gift');
  gift.hidden = !giftCode;
  // En iPhone, el navegador y la app instalada guardan relojes distintos: que no cree uno nuevo sin querer.
  gift.textContent = standalone ? T('gift.app') : T('gift.browser', { code: giftCode });
  $('#recover').hidden = !saved.oldKeys?.length;
}

/* ───────── las llaves nunca se borran solas ───────── */

/** Guarda una llave que deja de usarse (máx. 5): así ningún error ni cambio de llave hace perder un reloj. */
function rememberKey(key) {
  if (!key) return;
  saved.oldKeys = [key, ...(saved.oldKeys || []).filter((k) => k !== key)].slice(0, 5);
}

async function recoverClock() {
  const btn = $('#btn-recover');
  btn.disabled = true;
  for (const key of saved.oldKeys || []) {
    saved.token = key;
    try {
      const state = await api('GET', '/api/state');
      saved.oldKeys = saved.oldKeys.filter((k) => k !== key);
      apply(state);
      toast(T('recover.ok'));
      btn.disabled = false;
      return;
    } catch (err) {
      saved.token = null;
      if (err.offline) break;
    }
  }
  persist();
  btn.disabled = false;
  toast(T('recover.none'));
}

function render() {
  if (!S || !saved.token) return renderIntro();
  $('#gift').hidden = true;
  $('#recover').hidden = true; // el aviso de recuperar solo tiene sentido en la pantalla de inicio
  $('#life').textContent = S.nickname ? `${S.nickname} · ${T('life', { n: S.lifeNo })}` : T('life', { n: S.lifeNo });
  $('#btn-rebirth').textContent = T('rebirthWith', { x: fmtLong(S.initialSeconds) });
  lastMinute = -1;
  tick();
  if ($('#sheet-history').open) renderHistory();
}

function tick() {
  clearTimeout(timer);
  if (!S || !saved.token) return;
  const rem = S.expiresAt - now();
  clock.set(rem);

  const body = document.body;
  const mood = moodFor(rem);
  const phase = mood === 'dead' ? 'dead' : 'alive';
  if (body.dataset.mood !== mood || body.dataset.phase !== phase) {
    const wasAlive = body.dataset.phase === 'alive';
    const prev = body.dataset.mood;
    body.dataset.mood = mood;
    body.dataset.phase = phase;
    $('#status').textContent = T(`status.${mood}`);
    if (wasAlive && prev !== mood) vibrate(mood === 'dead' ? [280, 120, 280] : mood === 'critical' ? 60 : 0);
    lastMinute = -1;
  }

  const minute = Math.floor(rem / 60_000);
  if (minute !== lastMinute) {
    lastMinute = minute;
    renderMeta(rem);
    renderLast(rem);
  }
  // Despierta justo cuando cambia el segundo visible.
  if (rem > 0) timer = setTimeout(tick, (rem % 1000 || 1000) + 10);
}

function renderMeta(rem) {
  const out = $('#expiry');
  if (rem > 0) {
    out.textContent = T('expires', { date: dtDate.format(S.expiresAt), time: dtTime.format(S.expiresAt) });
  } else {
    const lived = (S.expiresAt - S.bornAt) / 1000;
    const best = Math.max(lived, (S.record || 0) / 1000);
    out.textContent = T('lifeLasted', { x: fmtDur(lived, 3) }) + (best > lived ? T('yourRecord', { x: fmtDur(best, 3) }) : '');
  }
}

function renderLast(rem) {
  const t = S.ledger?.[0];
  const btn = $('#last');
  if (!t || rem <= 0) return void (btn.hidden = true);
  btn.hidden = false;
  btn.replaceChildren(
    el('span', `amt ${t.seconds > 0 ? 'up' : 'down'}`, signed(t.seconds)),
    el('span', 'txt', `${noteOf(t) || labelOf(t)} · ${rel(t.at)}`),
  );
}

/* ───────── hojas (bottom sheets) ───────── */

function openSheet(d) {
  if (!d.open) d.showModal();
}
function closeSheet(d) {
  if (!d.open || d.dataset.closing) return;
  d.dataset.closing = '1';
  d.classList.add('closing');
  const b = d.querySelector('.sheet-body');
  b.style.transition = 'transform .22s cubic-bezier(.4, 0, 1, 1)';
  b.style.transform = 'translateY(105%)';
  setTimeout(() => {
    d.close();
    d.classList.remove('closing');
    b.style.transition = '';
    b.style.transform = '';
    delete d.dataset.closing;
  }, 220);
}
function setupSheet(d) {
  const body = d.querySelector('.sheet-body');
  d.addEventListener('click', (e) => e.target === d && closeSheet(d)); // toque fuera
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeSheet(d);
  });
  // Deslizar hacia abajo para cerrar
  let y0 = null;
  let dy = 0;
  body.addEventListener('touchstart', (e) => {
    // No arrastrar la hoja si el dedo está subiendo una conversación con scroll propio.
    if (body.scrollTop > 0 || e.target.closest('.thread')?.scrollTop > 0 || e.target.closest('input, textarea')) return;
    y0 = e.touches[0].clientY;
    dy = 0;
    body.style.transition = 'none';
  }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    body.style.transform = dy ? `translateY(${dy}px)` : '';
  }, { passive: true });
  body.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    body.style.transition = '';
    if (dy > 90) closeSheet(d);
    else body.style.transform = '';
  });
}

function confirmSheet({ title, text, ok, danger = true }) {
  const d = $('#sheet-confirm');
  const yes = $('#cf-yes');
  const no = $('#cf-no');
  $('#cf-title').textContent = title;
  $('#cf-text').textContent = text;
  yes.textContent = ok;
  yes.className = `btn ${danger ? 'btn-danger' : 'btn-earn'}`;
  return new Promise((resolve) => {
    const finish = (v) => {
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      d.removeEventListener('close', onClose);
      resolve(v);
    };
    const onYes = () => (finish(true), closeSheet(d));
    const onNo = () => (finish(false), closeSheet(d));
    const onClose = () => finish(false);
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    d.addEventListener('close', onClose);
    openSheet(d);
  });
}

/* ───────── toast ───────── */

let toastTimer = 0;
let toastAction = null;
function toast(msg, action) {
  $('#toast-msg').textContent = msg;
  toastAction = action || null;
  const btn = $('#toast-act');
  btn.hidden = !action;
  if (action) btn.textContent = action.label;
  const t = $('#toast');
  if (t.showPopover) {
    // a la capa superior, por encima de cualquier hoja abierta (volver a mostrarlo lo sube al tope)
    if (t.matches(':popover-open')) t.hidePopover();
    t.showPopover();
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), action ? 6000 : 3200);
}

/* ───────── Dinero: lo que va en tu palabra ───────── */

let txMode = 'earn';
let txCat = ORDER.earn[0];
let txAmount = 0; // en la unidad de la categoría
let busy = false;

function openTx(mode) {
  setMode(mode);
  $('#tx-note').value = '';
  openSheet($('#sheet-tx'));
}
function setMode(mode) {
  txMode = mode;
  setCat(ORDER[mode][0]);
}
function setCat(cat, amount = 0) {
  txCat = cat;
  txAmount = amount;
  renderTx();
}

function usedLast24h(cat) {
  const since = now() - DAY * 1000;
  return (S?.ledger || []).reduce((sum, t) => (t.category === cat && t.at > since ? sum + t.amount : sum), 0);
}

function formula(c, amount) {
  const rate = c.rate === 1 ? '' : ` × ${num.format(c.rate)}`;
  const what = cText(c).label.toLowerCase();
  if (c.unit === 'money') {
    return amount
      ? `${cop.format(amount)}${rate} ÷ ${cop.format(DAY_VALUE)} ${T('formula.money')}`
      : T('formula.base', { dv: cop.format(DAY_VALUE) });
  }
  return amount
    ? T('formula.hours', { dur: fmtDur(amount * HOUR), what, rate })
    : T('formula.hoursBase', { what, dur: fmtDur(c.rate * HOUR) });
}

function suggestions(mode) {
  const out = [];
  const seen = new Set();
  const add = (x) => {
    const c = CATEGORIES[x.category];
    if (!x.note || !c || c.proof !== 'none' || c.dir > 0 !== (mode === 'earn')) return;
    const k = x.note.toLowerCase();
    if (!seen.has(k)) seen.add(k), out.push(x);
  };
  for (const x of saved.recent2 || []) add(x);
  for (const t of S?.ledger || []) add({ note: t.note, category: t.category, amount: t.amount });
  return out.slice(0, 6);
}

function remember(note, category, amount) {
  if (!note) return;
  const rest = (saved.recent2 || []).filter((x) => x.note.toLowerCase() !== note.toLowerCase());
  saved.recent2 = [{ note, category, amount }, ...rest].slice(0, 12);
  persist();
}

const moneyChip = (v) => T('moneyChip', { v });

function renderTx() {
  const d = $('#sheet-tx');
  const c = CATEGORIES[txCat];
  const earn = c.dir > 0;
  const money = c.unit === 'money';
  d.dataset.mode = txMode;
  d.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === txMode)));

  $('#tx-cats').replaceChildren(
    ...ORDER[txMode].map((k) => {
      const b = button(cText(CATEGORIES[k]).label, { cat: k });
      b.setAttribute('aria-pressed', String(k === txCat));
      return b;
    }),
  );
  $('#tx-hint').textContent = cText(c).hint + (c.cap ? T('capHint', { cap: c.cap }) : '');

  $('#tx-money-wrap').hidden = !money;
  const input = $('#tx-money');
  if (money && document.activeElement !== input) input.value = txAmount ? num.format(txAmount) : '';
  $('#tx-chips').replaceChildren(...CHIPS[c.unit].map((v) => button(money ? moneyChip(v) : `+${fmtDur(v * HOUR)}`, { v })));

  const secs = lifeSeconds(txCat, txAmount, MIN_WAGE);
  const amount = $('#tx-amount');
  amount.textContent = secs ? signed(secs) : '0m';
  amount.classList.toggle('zero', !secs);
  $('#tx-clear').hidden = !txAmount;
  $('#tx-formula').textContent = formula(c, txAmount);

  const used = c.cap ? usedLast24h(txCat) : 0;
  const overCap = Boolean(c.cap) && used + txAmount > c.cap;
  const after = (S ? S.expiresAt - now() : 0) + secs * 1000;
  const short = !earn && txAmount > 0 && after <= 0;
  const preview = $('#tx-preview');
  preview.textContent = !txAmount
    ? T(earn ? 'tx.seeEarn' : 'tx.seeSpend')
    : overCap ? T('tx.overCap', { used: fmtDur(used * HOUR) })
    : short ? T('tx.short')
    : T('tx.after', { x: fmtDur(after / 1000, 3) });
  preview.classList.toggle('warn', overCap || short);

  const submit = $('#tx-submit');
  submit.disabled = !secs || overCap || short || busy;
  submit.textContent = secs ? T(earn ? 'earnX' : 'spendX', { x: fmtDur(Math.abs(secs), 3) }) : T(earn ? 'earn' : 'spend');
  submit.className = `btn ${earn ? 'btn-earn' : 'btn-danger'}`;

  const list = suggestions(txMode);
  const box = $('#tx-suggest');
  box.hidden = !list.length;
  box.replaceChildren(
    ...list.map((x) => button(`${x.note} · ${amountOf(x.category, x.amount)}`, { note: x.note, cat: x.category, v: x.amount })),
  );
}

async function submitTx(e) {
  e.preventDefault();
  const secs = lifeSeconds(txCat, txAmount, MIN_WAGE);
  if (!secs || busy) return;
  const note = $('#tx-note').value.trim();
  busy = true;
  renderTx();
  try {
    const r = await api('POST', '/api/tx', { category: txCat, amount: txAmount, note });
    remember(note, txCat, txAmount);
    closeSheet($('#sheet-tx'));
    apply(r.state);
    const s = r.tx.seconds;
    clock.flash(s > 0 ? 'gain' : 'loss');
    vibrate(s > 0 ? 18 : [12, 50, 12]);
    toast(T('ofLife', { x: signed(s) }), { label: T('undo'), run: () => undo(r.tx.id) });
  } catch (err) {
    toast(err.message);
  } finally {
    busy = false;
    renderTx();
  }
}

async function undo(id) {
  try {
    apply((await api('DELETE', `/api/tx/${id}`)).state);
    toast(T('undone'));
  } catch (err) {
    toast(err.message);
  }
}

/* ───────── Mi día: el Guardián decide ───────── */

let day = saved.day || null; // conversación abierta (vista pública del servidor)
let dayPhotos = []; // fotos listas para el próximo mensaje
let dayBusy = false;
let pendingMine = null;

function openDay() {
  renderDay();
  openSheet($('#sheet-day'));
}
function openDayFromReminder() {
  if (document.body.dataset.phase !== 'alive') return;
  document.querySelectorAll('dialog.sheet[open]').forEach((d) => d.id !== 'sheet-day' && closeSheet(d));
  setTimeout(openDay, 260);
}
function closeDay() {
  day = null;
  saved.day = null;
  persist();
}

function userBubble(text, photos) {
  const b = el('div', 'bubble me', text || '');
  if (photos) b.append(el('span', 'photos', T('photos', { n: photos })));
  return b;
}

function judgeBubble(turn, last) {
  const b = el('div', 'bubble judge');
  const who = el('span', 'who', T('guardian'));
  if (synth) {
    const say = el('button', 'say');
    say.type = 'button';
    say.setAttribute('aria-label', T('listenVerdict'));
    say.innerHTML = SPEAKER_SVG;
    say.addEventListener('click', () => speakVerdict(turn));
    who.append(say);
  }
  b.append(who, el('span', null, turn.message));
  if (turn.items.length) {
    const list = el('div', 'items');
    for (const it of turn.items) {
      const c = CATEGORIES[it.category];
      const row = el('div', 'it');
      row.append(
        el('span', 'it-name', it.activity || (c && cText(c).label) || T('activity')),
        el('span', `it-life${it.seconds > 0 ? ' up' : it.seconds < 0 ? ' down' : ''}`, it.seconds ? signed(it.seconds) : '—'),
      );
      const metaLine = el('span', 'it-meta');
      metaLine.append(el('span', `badge ${it.verdict}`, T(`verdict.${it.verdict}`)));
      const what = c ? `${cText(c).label} · ${amountOf(it.category, it.amount)}${it.capped ? T('capped') : ''}` : '';
      metaLine.append(document.createTextNode([what, it.reason].filter(Boolean).join(' — ')));
      row.append(metaLine);
      list.append(row);
    }
    b.append(list);
  }
  if (last) {
    const net = turn.items.reduce((s, it) => s + it.seconds, 0);
    const total = el('p', 'net', T('dayTotal'));
    total.prepend(el('b', null, net ? signed(net) : '0m'));
    b.append(total);
  }
  return b;
}

function renderThumbs() {
  $('#d-thumbs').replaceChildren(
    ...dayPhotos.map((p, i) => {
      const t = el('div', 'thumb');
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = T('photoN', { n: i + 1 });
      const x = button('×', { rm: i });
      x.setAttribute('aria-label', T('removePhoto'));
      t.append(img, x);
      return t;
    }),
  );
}

/** Charlas con el Guardián que quedan hoy. Si pasó la medianoche desde la última foto del servidor, ya se renovaron. */
function dayQuota() {
  const per = S?.daysPerDay || DAYS_PER_DAY;
  const known = Number.isInteger(S?.daysLeft) && !(S.daysResetAt && now() >= S.daysResetAt);
  return { per, left: known ? S.daysLeft : per };
}

function quotaText({ per, left }) {
  if (left <= 0) return T('quota.none', { per });
  if (left >= per) return T('quota.full', { per });
  return T('quota.some', { left, per });
}

function renderDay() {
  const turns = day?.turns || [];
  const quota = dayQuota();
  const lastJudge = turns.findLastIndex((t) => t.role === 'judge');
  const nodes = turns.map((t, i) => (t.role === 'user' ? userBubble(t.text, t.photos) : judgeBubble(t, i === lastJudge)));
  if (dayBusy) {
    if (pendingMine) nodes.push(userBubble(pendingMine.text, pendingMine.photos));
    nodes.push(el('div', 'bubble judge thinking', T('reviewing')));
  }
  $('#d-thread').replaceChildren(...nodes);

  const hasVerdict = turns.at(-1)?.role === 'judge';
  const left = day ? day.maxReplies - day.rounds : 0;
  $('#d-form').hidden = Boolean(day) && (!hasVerdict || left <= 0) && !dayBusy;
  $('#d-text').placeholder = T(day ? 'day.replyPlaceholder' : 'day.placeholder');
  $('#d-send').textContent = T(day ? 'day.reply' : 'day.send');
  $('#d-send').disabled = dayBusy || (!day && quota.left <= 0);
  $('#d-left').textContent = day ? T('day.repliesLeft', { n: left }) : quotaText(quota);
  renderThumbs();

  $('#d-actions').hidden = !hasVerdict || dayBusy;
  if (hasVerdict) {
    const accept = $('#d-accept');
    accept.textContent = day.net ? T('day.accept', { x: signed(day.net) }) : T('day.closeNoChange');
    accept.className = `btn ${day.net < 0 ? 'btn-danger' : 'btn-earn'}`;
  }
  requestAnimationFrame(() => {
    const thread = $('#d-thread');
    thread.scrollTo({ top: thread.scrollHeight, behavior: dayBusy ? 'smooth' : 'auto' });
  });
}

/** Achica la foto en el teléfono (máx. 1024 px, JPEG): sube rápido y gasta menos IA. */
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('foto'))), 'image/jpeg', 0.8),
  );
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  return { media_type: 'image/jpeg', data: String(dataUrl).split(',')[1], url: URL.createObjectURL(blob) };
}

async function addPhotos(e) {
  const files = [...e.target.files];
  e.target.value = '';
  const room = 4 - dayPhotos.length;
  if (files.length > room) toast(T('maxPhotos'));
  for (const f of files.slice(0, room)) {
    try {
      dayPhotos.push(await shrink(f));
    } catch {
      toast(T('badPhoto'));
    }
  }
  renderThumbs();
}

/* ───────── Voz: dictado y lectura con lo que trae el navegador (sin costo) ───────── */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
// Brave expone la API pero no la conecta a ningún servicio: siempre falla con "network".
const IS_BRAVE = typeof navigator.brave !== 'undefined';
let micWanted = false; // el usuario quiere seguir dictando
let silentRestarts = 0;
const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>';
let rec = null;
let recBase = '';
let voice = null;

/** Arma el texto dictado. Chrome en Android repite frases acumulándolas: se reemplazan, no se suman. */
function transcriptOf(results) {
  const finals = [];
  let interim = '';
  for (const r of results) {
    const t = r[0].transcript.trim();
    if (!t) continue;
    if (!r.isFinal) {
      interim += (interim ? ' ' : '') + t;
      continue;
    }
    const prev = finals.at(-1);
    if (prev && t.toLowerCase().startsWith(prev.toLowerCase())) finals[finals.length - 1] = t;
    else finals.push(t);
  }
  return [...finals, interim].filter(Boolean).join(' ');
}

function setRecording(on) {
  const mic = $('#d-mic');
  mic.classList.toggle('rec', on);
  mic.setAttribute('aria-pressed', String(on));
  mic.setAttribute('aria-label', T(on ? 'mic.stop' : 'mic.start'));
  $('#d-text').placeholder = T(on ? 'day.listening' : day ? 'day.replyPlaceholder' : 'day.placeholder');
}

function micNote(msg) {
  const n = $('#d-mic-note');
  n.textContent = msg;
  n.hidden = !msg;
}

function stopMic() {
  micWanted = false;
  if (!rec) return;
  const r = rec;
  rec = null;
  try {
    r.stop();
  } catch {}
  setRecording(false);
}

function toggleMic() {
  if (rec) return stopMic();
  if (!SR || IS_BRAVE) {
    micNote(T('noDictation'));
    $('#d-text').focus(); // en el celular abre el teclado, que trae su propio micrófono
    return;
  }
  synth?.cancel();
  micNote('');
  micWanted = true;
  silentRestarts = 0;
  listen();
  vibrate(10);
}

/** Una sesión de escucha. Chrome corta tras unos segundos de silencio: si sigues dictando, retoma solo. */
function listen() {
  const area = $('#d-text');
  recBase = area.value.trim() ? `${area.value.trim()} ` : '';
  let heard = false;
  const r = new SR();
  r.lang = T('speech.lang');
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (e) => {
    heard = true;
    area.value = recBase + transcriptOf(e.results);
  };
  r.onerror = (e) => {
    if (e.error === 'aborted' || e.error === 'no-speech') return; // el silencio lo resuelve onend
    micWanted = false;
    micNote(
      e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? T('mic.denied')
        : e.error === 'audio-capture'
          ? T('mic.none')
          : e.error === 'network'
            ? T('mic.network')
            : T('mic.failed'),
    );
  };
  r.onend = () => {
    if (rec !== r) return; // lo paró el usuario
    silentRestarts = heard ? 0 : silentRestarts + 1;
    if (micWanted && silentRestarts < 3) return listen();
    rec = null;
    micWanted = false;
    setRecording(false);
  };
  try {
    r.start();
    rec = r;
    setRecording(true);
  } catch {
    rec = null;
    micWanted = false;
    setRecording(false);
    micNote(T('mic.open'));
  }
}

function pickVoice() {
  const voices = synth?.getVoices() || [];
  const prefs = LANG === 'es' ? [/^es[-_]CO/i, /^es[-_](MX|US|419)/i, /^es/i] : [/^en[-_]US/i, /^en[-_](GB|AU|CA)/i, /^en/i];
  voice = null;
  for (const re of prefs) if ((voice = voices.find((v) => re.test(v.lang)))) break;
  voice ||= null;
}

function speak(text) {
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice?.lang || T('speech.lang');
  u.rate = 1.02;
  u.pitch = 0.92;
  synth.speak(u);
}

const spokenDur = (s) => T('speech.dur', { s });

function speakVerdict(turn) {
  const net = turn.items.reduce((sum, it) => sum + it.seconds, 0);
  speak(T('speech.total', { msg: turn.message, dur: spokenDur(net) }));
}

function renderVoiceToggle() {
  const b = $('#d-voice');
  b.setAttribute('aria-pressed', String(Boolean(saved.voice)));
  b.setAttribute('aria-label', T(saved.voice ? 'voice.on' : 'voice.off'));
}

function toggleVoice() {
  saved.voice = !saved.voice;
  persist();
  renderVoiceToggle();
  if (saved.voice) {
    // Este toque también "desbloquea" la voz en iPhone para lecturas automáticas posteriores.
    const last = day?.turns.findLast((t) => t.role === 'judge');
    if (last) speakVerdict(last);
    else speak(T('speech.ready'));
  } else synth?.cancel();
}

async function sendDay(e) {
  e.preventDefault();
  if (dayBusy) return;
  stopMic();
  const text = $('#d-text').value.trim();
  if (!day && !text) return toast(T('day.empty'));
  if (day && !text && !dayPhotos.length) return toast(T('day.emptyReply'));
  const images = dayPhotos.map(({ media_type, data }) => ({ media_type, data }));
  pendingMine = { text, photos: images.length };
  dayBusy = true;
  renderDay();
  try {
    const r = day
      ? await api('POST', `/api/day/${day.id}/reply`, { text, images })
      : await api('POST', '/api/day', { text, images, tz: userTz() });
    day = r.day;
    saved.day = day;
    if (r.state) apply(r.state);
    else persist();
    $('#d-text').value = '';
    dayPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    dayPhotos = [];
    vibrate(12);
    if (saved.voice) speakVerdict(day.turns.at(-1));
  } catch (err) {
    if (err.status === 404 || err.code === 'closed') closeDay();
    if (err.code === 'days' && S) S = { ...S, daysLeft: 0, daysResetAt: null }; // el servidor manda: hoy ya no quedan
    toast(err.message);
  } finally {
    dayBusy = false;
    pendingMine = null;
    renderDay();
  }
}

async function acceptDay() {
  if (!day) return;
  try {
    const r = await api('POST', `/api/day/${day.id}/accept`);
    closeDay();
    closeSheet($('#sheet-day'));
    apply(r.state);
    if (r.net) {
      clock.flash(r.net > 0 ? 'gain' : 'loss');
      vibrate(r.net > 0 ? 18 : [12, 50, 12]);
    }
    toast(r.net ? T('ofLife', { x: signed(r.net) }) : T('day.closed'));
  } catch (err) {
    if (err.status === 404 || err.code === 'closed') closeDay(), renderDay();
    toast(err.message);
  }
}

async function discardDay() {
  if (!day) return;
  await api('POST', `/api/day/${day.id}/discard`).catch(() => {});
  closeDay();
  closeSheet($('#sheet-day'));
  toast(T('day.discarded'));
}

/* ───────── Transferir tiempo: código + QR ───────── */

let shareTab = 'send';
let shareAmount = 0;
let shareCode = saved.share && saved.share.expiresAt > Date.now() ? saved.share : null;
let codeTimer = 0;
let pollTimer = 0;

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const q = 4; // margen de silencio
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const size = n + 2 * q;
  return (
    `<svg viewBox="${-q} ${-q} ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${T('qrCode')}">` +
    `<rect x="${-q}" y="${-q}" width="${size}" height="${size}" fill="#eaf8e2"/><path d="${d}" fill="#0c1a08"/></svg>`
  );
}

function openShare(tab = 'send', code = '') {
  shareTab = tab;
  if (code) $('#sh-input').value = code;
  renderShare();
  openSheet($('#sheet-share'));
  if (shareCode) pollCode();
}

function renderShare() {
  $('#sheet-share').querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === shareTab)));
  const sending = shareTab === 'send';
  $('#sh-send').hidden = !sending || Boolean(shareCode);
  $('#sh-code').hidden = !sending || !shareCode;
  $('#sh-recv').hidden = sending;
  $('#sh-scan').hidden = $('#sh-or').hidden = !canScan();

  if (sending && shareCode) return renderCode();
  if (!sending) return;
  $('#sh-chips').replaceChildren(...SHARE_CHIPS.map((v) => button(`+${fmtDur(v)}`, { v })));
  const amount = $('#sh-amount');
  amount.textContent = shareAmount ? fmtDur(shareAmount, 3) : '0m';
  amount.classList.toggle('zero', !shareAmount);
  $('#sh-clear').hidden = !shareAmount;
  const after = (S ? S.expiresAt - now() : 0) - shareAmount * 1000;
  const short = shareAmount > 0 && after < 60_000;
  $('#sh-preview').textContent = !shareAmount
    ? T('share.pick')
    : short
      ? T('share.all')
      : T('share.after', { x: fmtDur(after / 1000, 3) });
  $('#sh-preview').classList.toggle('warn', short);
  const create = $('#sh-create');
  create.disabled = !shareAmount || short;
  create.textContent = shareAmount ? T('share.createX', { x: fmtDur(shareAmount, 3) }) : T('share.create');
}

function renderCode() {
  const text = $('#sh-codetext');
  if (text.dataset.code !== shareCode.code) {
    text.dataset.code = shareCode.code;
    text.textContent = `${shareCode.code.slice(0, 3)} ${shareCode.code.slice(3)}`;
    $('#sh-qr').innerHTML = qrSvg(`${location.origin}/r/${shareCode.code}`);
  }
  tickCode();
}

function tickCode() {
  clearTimeout(codeTimer);
  if (!shareCode) return;
  const left = Math.max(0, shareCode.expiresAt - now());
  const m = Math.floor(left / 60_000);
  const s = Math.floor(left / 1000) % 60;
  $('#sh-status').textContent = T('share.waiting', { x: fmtDur(shareCode.seconds, 3), m, ss: String(s).padStart(2, '0') });
  if (left > 0) codeTimer = setTimeout(tickCode, 1000);
  else checkCode();
}

function endCode() {
  shareCode = null;
  saved.share = null;
  persist();
  clearTimeout(codeTimer);
  clearTimeout(pollTimer);
  renderShare();
}

async function checkCode() {
  if (!shareCode) return;
  try {
    const st = await api('GET', `/api/transfer/${shareCode.code}`);
    if (st.status === 'entregado') {
      endCode();
      vibrate([20, 60, 20]);
      toast(T('share.delivered', { name: st.toName, x: fmtDur(st.seconds, 3) }));
      refresh();
    } else if (st.status === 'devuelto') {
      endCode();
      toast(T('share.returned'));
      refresh();
    }
  } catch (err) {
    if (err.status === 404) endCode();
  }
}

function pollCode() {
  clearTimeout(pollTimer);
  if (!shareCode || !$('#sheet-share').open) return;
  checkCode().finally(() => {
    if (shareCode) pollTimer = setTimeout(pollCode, 3000);
  });
}

async function createCode() {
  const btn = $('#sh-create');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/transfer', { seconds: shareAmount });
    shareCode = r.transfer;
    saved.share = shareCode;
    shareAmount = 0;
    apply(r.state);
    clock.flash('loss');
    vibrate(15);
    renderShare();
    pollTimer = setTimeout(pollCode, 3000);
  } catch (err) {
    toast(err.message);
    renderShare();
  }
}

async function cancelCode() {
  if (!shareCode) return;
  try {
    apply((await api('DELETE', `/api/transfer/${shareCode.code}`)).state);
    toast(T('share.canceled'));
    endCode();
  } catch (err) {
    toast(err.message);
    checkCode();
  }
}

async function claimCode(raw) {
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return toast(T('share.sixChars'));
  try {
    const r = await api('POST', '/api/transfer/claim', { code });
    closeSheet($('#sheet-share'));
    $('#sh-input').value = '';
    apply(r.state);
    clock.flash('gain');
    vibrate([20, 60, 20]);
    toast(T('share.got', { x: fmtDur(r.seconds, 3), name: r.fromName }));
  } catch (err) {
    toast(err.message);
  }
}

/* ───────── escanear QR dentro de la app ───────── */

let stopScan = null;

const scanText = (mode, what) => T(`scan.${mode}.${what}`);

/** mode: 'code' (regalo de tiempo) o 'key' (abrir tu reloj en este dispositivo). Lee cualquiera de los dos. */
async function openScanner(mode = 'code') {
  const d = $('#sheet-scan');
  $('#sc-title').textContent = scanText(mode, 'title');
  $('#scan-msg').textContent = scanText(mode, 'hint');
  $('.viewfinder').classList.remove('hit');
  openSheet(d);
  try {
    const stop = await startScan($('#scan-video'), {
      onFound: ({ kind, value }) => {
        stopScan = null;
        $('.viewfinder').classList.add('hit');
        vibrate(25);
        setTimeout(() => {
          closeSheet(d);
          if (kind === 'key') useKey(value);
          else if (S) claimCode(value);
          else toast(T('scan.first'));
        }, 250);
      },
      onOther: () => ($('#scan-msg').textContent = scanText(mode, 'other')),
    });
    if (d.open && !d.dataset.closing) stopScan = stop;
    else stop(); // cerró la hoja mientras pedía permiso
  } catch (err) {
    closeSheet(d);
    toast(
      err?.name === 'NotAllowedError'
        ? T('scan.denied')
        : T('scan.failed'),
    );
  }
}
function closeScanner() {
  stopScan?.();
  stopScan = null;
}

/* ───────── historial ───────── */

function renderHistory() {
  if (!S) return;
  const end = Math.min(now(), S.expiresAt);
  $('#st-earned').textContent = `+${fmtDur(S.earned)}`;
  $('#st-spent').textContent = `−${fmtDur(S.spent)}`;
  $('#st-lived').textContent = fmtDur((end - S.bornAt) / 1000);
  $('#h-title').textContent = T('life', { n: S.lifeNo });
  const rec = $('#st-record');
  rec.hidden = !S.record;
  if (S.record) rec.textContent = T('recordPrev', { x: fmtDur(S.record / 1000, 3) });

  const items = [];
  let dayName = '';
  for (const t of S.ledger) {
    const label = dayLabel(t.at);
    if (label !== dayName) items.push(el('li', 'day', (dayName = label)));
    const li = el('li', 'item');
    const info = el('span', 'info');
    info.append(el('span', 'note', noteOf(t) || labelOf(t)));
    const detail = detailOf(t);
    if (detail) info.append(el('small', 'detail', detail));
    li.append(el('span', `amt ${t.seconds > 0 ? 'up' : 'down'}`, signed(t.seconds)), info, el('time', null, dtTime.format(t.at)));
    items.push(li);
  }
  $('#ledger').replaceChildren(...items);
  $('#ledger-empty').hidden = S.ledger.length > 0;
}

function openHistory() {
  if (!S) return;
  renderHistory();
  openSheet($('#sheet-history'));
}

/* ───────── ciclo de vida ───────── */

const KEY_IN_TEXT = /tk_[\w-]{16,}/;

async function start() {
  const name = $('#intro-name').value.trim();
  const pasted = name.match(KEY_IN_TEXT);
  if (pasted) {
    // pegó su llave en el nombre: en realidad quiere abrir su reloj, no crear otro
    $('#intro-name').value = '';
    openSettings(true);
    $('#link-input').value = pasted[0];
    return toast(T('isKey'));
  }
  const b = $('#btn-start');
  b.disabled = true;
  try {
    const r = await api('POST', '/api/session', { nickname: name, deviceId: deviceId() });
    saved.token = r.token;
    apply(r.state);
    vibrate(30);
    openKeySheet(true); // lo primero: que sepa que esa llave es su identificador (el regalo se reclama al cerrarla)
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
}

/** ask: abrió un link de regalo en el navegador con un reloj ya guardado; puede que el suyo esté en la app. */
async function claimGift({ ask = false } = {}) {
  const code = giftCode;
  giftCode = null;
  await new Promise((r) => setTimeout(r, 600));
  if (ask && !standalone) {
    const life = T('life', { n: S?.lifeNo ?? 1 });
    const name = S?.nickname ? `${S.nickname} · ${life}` : life;
    const ok = await confirmSheet({
      title: T('gift.title'),
      text: T('gift.text', { name, code }),
      ok: T('gift.ok'),
      danger: false,
    });
    if (!ok) return toast(T('gift.yourCode', { code }));
  }
  claimCode(code);
}

async function rebirth(force = false) {
  try {
    const r = await api('POST', '/api/rebirth', { force });
    apply(r.state);
    clock.flash('gain');
    vibrate(30);
    toast(T('reborn', { n: r.state.lifeNo, x: fmtLong(r.state.initialSeconds) }));
  } catch (err) {
    toast(err.message);
  }
}

async function refresh() {
  if (!saved.token) return false;
  try {
    apply(await api('GET', '/api/state'));
    return true;
  } catch (err) {
    if (err.status === 401) {
      // El servidor no reconoce la llave. NO se borra: se guarda para reintentar (p. ej. tras un deploy fallido).
      rememberKey(saved.token);
      saved.token = null;
      S = null;
      closeDay();
      persist();
      renderIntro();
    } else if (!err.offline) toast(err.message);
    return false;
  }
}

/* ───────── ajustes ───────── */


async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS && !standalone ? 'ios' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
}

const userTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};
const remindText = (every) => T(`remind.${every}`);

async function renderRemind() {
  const every = S?.remindEvery ?? 43200;
  for (const b of document.querySelectorAll('#remind-seg button')) {
    b.setAttribute('aria-checked', String(Number(b.dataset.every) === every));
  }
  const st = await pushStatus();
  $('#remind-status').textContent = !every
    ? T('remind.off')
    : T(st === 'on' ? 'remind.on' : 'remind.needsPush', { x: remindText(every) });
}

async function setRemind(e) {
  const b = e.target.closest('button[data-every]');
  const every = Number(b?.dataset.every);
  if (!b || !S || every === S.remindEvery) return;
  try {
    apply((await api('PATCH', '/api/me', { remindEvery: every, tz: userTz() })).state);
    await renderRemind();
    if (!every) toast(T('remind.offToast'));
    else if ((await pushStatus()) === 'on') toast(T('remind.onToast', { x: remindText(every) }));
    else toast(T('remind.pushToast'));
  } catch (err) {
    toast(err.message);
  }
}

async function renderPush() {
  renderRemind();
  const st = await pushStatus();
  $('#push-status').textContent = T(`push.${st}`);
  const b = $('#btn-push');
  b.textContent = T(st === 'on' ? 'push.turnOff' : 'push.turnOn');
  b.disabled = st !== 'on' && st !== 'off';
  b.dataset.state = st;
}

function b64u(s) {
  const bin = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function togglePush() {
  const b = $('#btn-push');
  b.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const current = await reg.pushManager.getSubscription();
    if (b.dataset.state === 'on') {
      if (current) {
        await api('DELETE', '/api/push', { endpoint: current.endpoint }).catch(() => {});
        await current.unsubscribe();
      }
      toast(T('push.offToast'));
    } else {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error(T('push.noPermission'));
      const { publicKey } = await api('GET', '/api/push/key');
      await current?.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) });
      await api('POST', '/api/push', { ...sub.toJSON(), tz: userTz() });
      toast(T('push.onToast'));
    }
  } catch (err) {
    toast(err.message || T('push.failed'));
  }
  await renderPush();
}

async function syncPush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub && saved.token) await api('POST', '/api/push', { ...sub.toJSON(), tz: userTz() });
  } catch {}
}

let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  renderInstall();
});
function renderInstall() {
  const row = $('#row-install');
  const hint = $('#install-hint');
  if (standalone) return void (row.hidden = true);
  if (installEvent) {
    row.hidden = false;
    $('#btn-install').hidden = false;
    hint.textContent = T('install.hint');
  } else if (isIOS) {
    row.hidden = false;
    $('#btn-install').hidden = true;
    hint.textContent = T('install.ios');
  } else row.hidden = true;
}

const maskKey = (k) => (k ? `${k.slice(0, 7)}••••••${k.slice(-4)}` : '');

function openSettings(focusLink = false) {
  $('#key-text').textContent = maskKey(saved.token);
  $('#name-input').value = S?.nickname || '';
  renderNameCount();
  $('#rate-text').textContent = T('rate', { dv: cop.format(DAY_VALUE), mw: cop.format(MIN_WAGE) });
  renderLang();
  $('#foot').textContent = `Tiempo · ${VERSION}`;
  renderInstall();
  renderPush();
  $('#btn-scan-key').hidden = !canScan();
  openSheet($('#sheet-settings'));
  if (focusLink) setTimeout(() => $('#link-input').focus(), 380);
}

function renderLang() {
  for (const b of document.querySelectorAll('#lang-seg button')) b.setAttribute('aria-checked', String(b.dataset.lang === LANG));
}

/** Cambia el idioma: queda en este teléfono y la app recarga ya traducida (el servidor lo sabe por X-Lang). */
function setLang(e) {
  const lang = e.target.closest('button[data-lang]')?.dataset.lang;
  if (!lang || lang === LANG) return;
  if (!saveLang(lang)) return toast(T('net.failed'));
  vibrate(10);
  location.reload();
}

/* ───────── tu llave y tu nombre ───────── */

const graphemeCount = (s) =>
  typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(s)].length : s.length;

let keyIsWelcome = false;

function openKeySheet(welcome = false) {
  keyIsWelcome = welcome;
  $('#key-full').textContent = saved.token || '';
  $('#k-title').textContent = T(welcome ? 'key.welcome' : 'key.title');
  $('#k-done').textContent = T(welcome ? 'key.saved' : 'key.done');
  $('#key-qr').hidden = true; // escondido hasta que lo pida: que nadie lo fotografíe sin querer
  $('#k-qr').hidden = false;
  resetCopyButton();
  openSheet($('#sheet-key'));
}

function resetCopyButton() {
  const b = $('#k-copy');
  b.classList.remove('done');
  b.textContent = T('key.copy');
}

/** Selecciona la llave en pantalla, para copiarla a mano si el portapapeles no está disponible. */
function selectKey() {
  const range = document.createRange();
  range.selectNodeContents($('#key-full'));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function copyKey() {
  const b = $('#k-copy');
  try {
    await navigator.clipboard.writeText(saved.token);
  } catch {
    selectKey();
    toast(T('key.copyFailed'));
    return;
  }
  vibrate(15);
  // La confirmación se queda mientras la hoja esté abierta: que no quede duda de que se copió.
  b.classList.add('done');
  b.textContent = T('key.copied');
  toast(T('key.copiedToast'));
}

function keyDone() {
  if (keyIsWelcome) {
    saved.keySaved = true;
    persist();
  }
  closeSheet($('#sheet-key'));
}

function keyClosed() {
  if (!keyIsWelcome) return;
  keyIsWelcome = false;
  if (giftCode) claimGift();
  else toast(T('started'));
}

function renderNameCount() {
  const n = graphemeCount($('#name-input').value.trim());
  $('#name-count').textContent = `${n}/32`;
}

async function saveName(e) {
  e.preventDefault();
  const input = $('#name-input');
  if (KEY_IN_TEXT.test(input.value)) return toast(T('name.isKey'));
  try {
    apply((await api('PATCH', '/api/me', { nickname: input.value })).state);
    input.value = S.nickname;
    renderNameCount();
    input.blur();
    toast(S.nickname ? T('name.saved', { name: S.nickname }) : T('name.removed'));
  } catch (err) {
    toast(err.message);
  }
}

async function rotateKey() {
  closeSheet($('#sheet-settings'));
  const ok = await confirmSheet({
    title: T('rotate.title'),
    text: T('rotate.text'),
    ok: T('rotate.ok'),
  });
  if (!ok) return;
  try {
    const r = await api('POST', '/api/me/key');
    saved.token = r.token; // la vieja ya no sirve: no se guarda
    saved.keySaved = false;
    apply(r.state);
    persist();
    syncPush();
    openKeySheet(false);
    $('#k-title').textContent = T('key.new');
    toast(T('rotate.done'));
  } catch (err) {
    toast(err.message);
  }
}

function linkKey(e) {
  e.preventDefault();
  useKey($('#link-input').value.trim());
}

/** Abre en este dispositivo el reloj de esa llave (pegada o escaneada). La llave actual nunca se pierde. */
async function useKey(key) {
  const input = $('#link-input');
  if (!/^tk_[\w-]{16,}$/.test(key)) return toast(T('use.invalid'));
  if (key === saved.token) return toast(T('use.same'));
  closeSheet($('#sheet-settings'));
  if (saved.token) {
    const ok = await confirmSheet({
      title: T('use.title'),
      text: T('use.text'),
      ok: T('use.ok'),
    });
    if (!ok) return;
  }
  const prev = saved.token;
  saved.token = key;
  try {
    apply(await api('GET', '/api/state'));
    rememberKey(prev); // la llave anterior queda guardada: cambiar de llave tampoco hace perder un reloj
    saved.oldKeys = (saved.oldKeys || []).filter((k) => k !== key);
    persist();
    input.value = '';
    closeDay();
    shareCode = null;
    saved.share = null;
    persist();
    toast(T('use.done'));
    syncPush();
    if (giftCode) claimGift();
  } catch (err) {
    saved.token = prev;
    persist();
    toast(err.status === 401 ? T('use.missing') : err.message);
  }
}

async function resetLife() {
  closeSheet($('#sheet-settings'));
  const rem = S ? Math.max(0, S.expiresAt - now()) / 1000 : 0;
  const ok = await confirmSheet({
    title: T('reset.title'),
    text: T('reset.text', { rem: rem ? fmtDur(rem, 3) : '', x: fmtLong(S?.initialSeconds || INITIAL) }),
    ok: T('reset.ok'),
  });
  if (ok) rebirth(true);
}

/* ───────── service worker ───────── */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.open === 'day') openDayFromReminder(); // tocó el recordatorio con la app ya abierta
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Nueva versión desplegada: recarga, pero nunca a mitad de una acción; si hay una hoja abierta,
    // recarga apenas se cierre (antes se quedaba con la versión vieja hasta cerrar la app del todo).
    if (!hadController) return;
    updateReady = true;
    reloadIfIdle();
  });
  // Cualquier hoja que se cierra: si había una versión nueva esperando, se aplica.
  document.addEventListener('close', () => updateReady && setTimeout(reloadIfIdle, 350), true);
}

let updateReady = false;
let lastUpdateCheck = Date.now();
function reloadIfIdle() {
  if (updateReady && !document.querySelector('dialog[open]')) location.reload();
}
/** En iPhone la app vuelve de segundo plano sin recargar: ahí nadie buscaba versiones nuevas. */
function checkForUpdate() {
  if (Date.now() - lastUpdateCheck < 60_000) return;
  lastUpdateCheck = Date.now();
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
}

/* ───────── eventos ───────── */

$('#btn-start').addEventListener('click', start);
$('#btn-recover').addEventListener('click', recoverClock);
$('#btn-have-key').addEventListener('click', () => openSettings(true));
$('#btn-day').addEventListener('click', openDay);
$('#btn-money').addEventListener('click', () => openTx('earn'));
$('#btn-share').addEventListener('click', () => openShare());
$('#btn-rebirth').addEventListener('click', () => rebirth(false));
$('#btn-history').addEventListener('click', openHistory);
$('#last').addEventListener('click', openHistory);
$('#btn-settings').addEventListener('click', () => openSettings());

// Dinero
$('#tx-form').addEventListener('submit', submitTx);
$('#tx-cats').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (b && b.dataset.cat !== txCat) setCat(b.dataset.cat);
});
$('#tx-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  txAmount = Math.min(txAmount + Number(b.dataset.v), MAX_AMOUNT[CATEGORIES[txCat].unit]);
  vibrate(8);
  renderTx();
});
$('#tx-money').addEventListener('input', (e) => {
  const digits = e.target.value.replace(/\D/g, '').slice(0, 11);
  txAmount = Number(digits) || 0;
  e.target.value = digits ? num.format(txAmount) : '';
  renderTx();
});
$('#tx-clear').addEventListener('click', () => {
  txAmount = 0;
  $('#tx-money').value = '';
  renderTx();
});
$('#tx-suggest').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  $('#tx-note').value = b.dataset.note;
  $('#tx-money').blur();
  setCat(b.dataset.cat, Number(b.dataset.v));
  vibrate(8);
});
document.querySelectorAll('#sheet-tx .seg button').forEach((b) =>
  b.addEventListener('click', () => b.dataset.mode !== txMode && setMode(b.dataset.mode)),
);

// Mi día
$('#d-form').addEventListener('submit', sendDay);
$('#d-file').addEventListener('change', addPhotos);
$('#d-thumbs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-rm]');
  if (!b) return;
  const [p] = dayPhotos.splice(Number(b.dataset.rm), 1);
  URL.revokeObjectURL(p.url);
  renderThumbs();
});
$('#d-accept').addEventListener('click', acceptDay);
$('#d-discard').addEventListener('click', discardDay);
$('#d-mic').addEventListener('click', toggleMic);
$('#d-voice').addEventListener('click', toggleVoice);
$('#sheet-day').addEventListener('close', () => {
  stopMic();
  synth?.cancel();
});
$('#d-mic').hidden = !SR;
$('#d-voice').hidden = !synth;
renderVoiceToggle();
if (synth) {
  pickVoice();
  synth.addEventListener?.('voiceschanged', pickVoice);
}

// Transferir
$('#sheet-share .seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  shareTab = b.dataset.tab;
  renderShare();
});
$('#sh-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  shareAmount = Math.min(shareAmount + Number(b.dataset.v), 10 * 365 * DAY);
  vibrate(8);
  renderShare();
});
$('#sh-clear').addEventListener('click', () => {
  shareAmount = 0;
  renderShare();
});
$('#sh-create').addEventListener('click', createCode);
$('#sh-cancel').addEventListener('click', cancelCode);
$('#sh-recv').addEventListener('submit', (e) => {
  e.preventDefault();
  claimCode($('#sh-input').value);
});
$('#sheet-share').addEventListener('close', () => clearTimeout(pollTimer));
$('#sh-scan').addEventListener('click', () => openScanner('code'));
$('#btn-scan-key').addEventListener('click', () => openScanner('key'));
$('#scan-cancel').addEventListener('click', () => closeSheet($('#sheet-scan')));
$('#sheet-scan').addEventListener('close', closeScanner); // la cámara se apaga siempre al cerrar
document.addEventListener('visibilitychange', () => {
  if (document.hidden && $('#sheet-scan').open) closeSheet($('#sheet-scan'));
});

// Ajustes
$('#btn-push').addEventListener('click', togglePush);
$('#remind-seg').addEventListener('click', setRemind);
$('#lang-seg').addEventListener('click', setLang);
$('#btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  renderInstall();
});
$('#btn-show-key').addEventListener('click', () => {
  closeSheet($('#sheet-settings'));
  setTimeout(() => openKeySheet(false), 240);
});
$('#k-copy').addEventListener('click', copyKey);
$('#k-qr').addEventListener('click', () => {
  if (!saved.token) return;
  $('#key-qr-img').innerHTML = qrSvg(saved.token);
  $('#key-qr').hidden = false;
  $('#k-qr').hidden = true;
});
$('#sheet-key').addEventListener('close', () => $('#key-qr-img').replaceChildren());
$('#k-done').addEventListener('click', keyDone);
$('#sheet-key').addEventListener('close', keyClosed);
$('#name-form').addEventListener('submit', saveName);
$('#name-input').addEventListener('input', renderNameCount);
$('#intro-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
$('#link-form').addEventListener('submit', linkKey);
$('#btn-reset').addEventListener('click', resetLife);
$('#btn-rotate').addEventListener('click', rotateKey);
$('#toast-act').addEventListener('click', () => {
  const a = toastAction;
  toastAction = null;
  $('#toast').classList.remove('show');
  a?.run();
});
document.querySelectorAll('dialog.sheet').forEach(setupSheet);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  tick();
  if (Date.now() - lastSync > 15_000) refresh();
  checkForUpdate();
});
addEventListener('online', refresh);

/* ───────── arranque ───────── */

translatePage({ n: DAYS_PER_DAY });
render(); // pinta al instante con lo guardado; luego sincroniza
registerSW();
navigator.storage?.persist?.().catch(() => {});
if (saved.token) {
  refresh().then((ok) => {
    syncPush();
    if (ok && giftCode) claimGift({ ask: true });
    else if (ok && dayOnLoad) openDayFromReminder();
    dayOnLoad = false;
  });
}
