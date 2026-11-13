import { Clock } from './clock.js';
import { CATEGORIES, lifeSeconds, dayValue } from './economy.js';
import qrcode from './vendor/qrcode.mjs';

const $ = (sel) => document.querySelector(sel);
const DAY = 86_400, HOUR = 3_600, MIN = 60, WEEK = 7 * DAY;
const STORE_KEY = 'tiempo.v1';
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;
const INITIAL = Number(meta('initial-seconds')) || WEEK;
const MIN_WAGE = Number(meta('min-wage')) || 1_750_905;
const DAY_VALUE = dayValue(MIN_WAGE);
const VERSION = meta('app-version') || 'dev';
const STATUS = { ok: 'Tiempo restante', low: 'Último día', critical: 'Última hora', dead: 'Tiempo agotado' };
// A mano solo entra lo que va "en tu palabra"; lo demás pasa por el Guardián.
const ORDER = { earn: ['ingreso', 'inversion'], spend: ['consumo'] };
const CHIPS = { money: [5_000, 20_000, 50_000, 100_000, 500_000, 1_000_000], hours: [0.25, 0.5, 1, 2, 4, 8] };
const MAX_AMOUNT = { money: 10_000_000_000, hours: 24 };
const SHARE_CHIPS = [300, 900, 3_600, 21_600, DAY, WEEK];
const VERDICT_LABEL = { aprobado: 'Aprobado', rechazado: 'Rechazado', necesita_prueba: 'Falta prueba', no_cuenta: 'No cuenta' };
const cop = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('es-CO');

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
  for (const [n, one, many] of [[WEEK, 'semana', 'semanas'], [DAY, 'día', 'días'], [HOUR, 'hora', 'horas']]) {
    const v = sec / n;
    if (Number.isInteger(v)) return `${v} ${v === 1 ? one : many}`;
  }
  return fmtDur(sec, 3);
}
function amountOf(category, amount) {
  const unit = CATEGORIES[category]?.unit;
  return unit === 'money' ? cop.format(amount) : unit === 'seconds' ? fmtDur(amount, 3) : fmtDur(amount * HOUR);
}
const labelOf = (t) => CATEGORIES[t.category]?.label || (t.seconds > 0 ? 'Ganado' : 'Gastado');
function detailOf(t) {
  const c = CATEGORIES[t.category];
  if (!c) return '';
  const seal = t.status === 'verificado' ? ' · ✓ con prueba' : t.status === 'aprobado' ? ' · ✓ Guardián' : '';
  return `${c.label} · ${amountOf(t.category, t.amount)}${seal}`;
}
const dtDate = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });
const dtTime = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const dtDay = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'short' });
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'short' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function rel(ts) {
  const s = Math.round((ts - now()) / 1000);
  const a = Math.abs(s);
  if (a < MIN) return 'ahora';
  if (a < HOUR) return rtf.format(Math.round(s / MIN), 'minute');
  if (a < DAY) return rtf.format(Math.round(s / HOUR), 'hour');
  return rtf.format(Math.round(s / DAY), 'day');
}
function dayLabel(ts) {
  const d = new Date(ts).toDateString();
  const today = new Date();
  if (d === today.toDateString()) return 'Hoy';
  today.setDate(today.getDate() - 1);
  if (d === today.toDateString()) return 'Ayer';
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
      },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Sin conexión'), { offline: true });
  }
  const mid = (t0 + Date.now()) / 2;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'Algo falló'), { status: res.status, code: data.error });
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

const clock = new Clock($('#clock'));
let timer = 0;
let lastMinute = -1;
const moodFor = (rem) => (rem <= 0 ? 'dead' : rem <= HOUR * 1000 ? 'critical' : rem <= DAY * 1000 ? 'low' : 'ok');

function renderIntro() {
  clearTimeout(timer);
  document.body.dataset.phase = 'intro';
  document.body.dataset.mood = 'ok';
  clock.set(INITIAL * 1000);
  $('#status').textContent = 'Tu reloj';
  $('#life').textContent = '';
  $('#intro-initial').textContent = fmtLong(INITIAL);
  const gift = $('#gift');
  gift.hidden = !giftCode;
  gift.textContent = 'Alguien te está regalando tiempo. Empieza tu reloj para recibirlo.';
}

function render() {
  if (!S || !saved.token) return renderIntro();
  $('#gift').hidden = true;
  $('#life').textContent = S.nickname ? `${S.nickname} · Vida ${S.lifeNo}` : `Vida ${S.lifeNo}`;
  $('#btn-rebirth').textContent = `Renacer con ${fmtLong(S.initialSeconds)}`;
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
    $('#status').textContent = STATUS[mood];
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
    out.textContent = `Se agota el ${dtDate.format(S.expiresAt)} a las ${dtTime.format(S.expiresAt)}`;
  } else {
    const lived = (S.expiresAt - S.bornAt) / 1000;
    const best = Math.max(lived, (S.record || 0) / 1000);
    out.textContent = `Esta vida duró ${fmtDur(lived, 3)}.` + (best > lived ? ` Tu récord: ${fmtDur(best, 3)}.` : '');
  }
}

function renderLast(rem) {
  const t = S.ledger?.[0];
  const btn = $('#last');
  if (!t || rem <= 0) return void (btn.hidden = true);
  btn.hidden = false;
  btn.replaceChildren(
    el('span', `amt ${t.seconds > 0 ? 'up' : 'down'}`, signed(t.seconds)),
    el('span', 'txt', `${t.note || labelOf(t)} · ${rel(t.at)}`),
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
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), action ? 6000 : 3200);
}

/* ───────── Plata: lo que va en tu palabra ───────── */

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
  const rate = c.rate === 1 ? '' : ` × ${String(c.rate).replace('.', ',')}`;
  const what = c.label.toLowerCase();
  if (c.unit === 'money') {
    return amount
      ? `${cop.format(amount)}${rate} ÷ ${cop.format(DAY_VALUE)} por día`
      : `1 día de vida = ${cop.format(DAY_VALUE)}, un salario mínimo diario`;
  }
  return amount ? `${fmtDur(amount * HOUR)} de ${what}${rate}` : `1 h de ${what} = ${fmtDur(c.rate * HOUR)} de vida`;
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

const moneyChip = (v) => (v >= 1e6 ? `+${v / 1e6} M` : `+${v / 1e3} mil`);

function renderTx() {
  const d = $('#sheet-tx');
  const c = CATEGORIES[txCat];
  const earn = c.dir > 0;
  const money = c.unit === 'money';
  d.dataset.mode = txMode;
  d.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === txMode)));

  $('#tx-cats').replaceChildren(
    ...ORDER[txMode].map((k) => {
      const b = button(CATEGORIES[k].label, { cat: k });
      b.setAttribute('aria-pressed', String(k === txCat));
      return b;
    }),
  );
  $('#tx-hint').textContent = c.hint + (c.cap ? ` Cuentan máximo ${c.cap} h cada 24 h.` : '');

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
    ? earn ? 'Mira cuánta vida vale lo que ganaste.' : 'Mira cuánta vida te costó.'
    : overCap ? `Te pasas del máximo: ya llevas ${fmtDur(used * HOUR)} en las últimas 24 h.`
    : short ? 'No te alcanza: eso te dejaría en cero.'
    : `Te quedarán ${fmtDur(after / 1000, 3)}.`;
  preview.classList.toggle('warn', overCap || short);

  const submit = $('#tx-submit');
  submit.disabled = !secs || overCap || short || busy;
  submit.textContent = secs ? `${earn ? 'Ganar' : 'Gastar'} ${fmtDur(Math.abs(secs), 3)}` : earn ? 'Ganar' : 'Gastar';
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
    toast(`${signed(s)} de vida`, { label: 'Deshacer', run: () => undo(r.tx.id) });
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
    toast('Movimiento deshecho');
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
function closeDay() {
  day = null;
  saved.day = null;
  persist();
}

function userBubble(text, photos) {
  const b = el('div', 'bubble me', text || '');
  if (photos) b.append(el('span', 'photos', photos === 1 ? '1 foto' : `${photos} fotos`));
  return b;
}

function judgeBubble(turn, last) {
  const b = el('div', 'bubble judge');
  const who = el('span', 'who', 'Guardián');
  if (synth) {
    const say = el('button', 'say');
    say.type = 'button';
    say.setAttribute('aria-label', 'Escuchar este veredicto');
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
        el('span', 'it-name', it.activity || c?.label || 'Actividad'),
        el('span', `it-life${it.seconds > 0 ? ' up' : it.seconds < 0 ? ' down' : ''}`, it.seconds ? signed(it.seconds) : '—'),
      );
      const metaLine = el('span', 'it-meta');
      metaLine.append(el('span', `badge ${it.verdict}`, VERDICT_LABEL[it.verdict] || it.verdict));
      const what = c ? `${c.label} · ${amountOf(it.category, it.amount)}${it.capped ? ' (tope)' : ''}` : '';
      metaLine.append(document.createTextNode([what, it.reason].filter(Boolean).join(' — ')));
      row.append(metaLine);
      list.append(row);
    }
    b.append(list);
  }
  if (last) {
    const net = turn.items.reduce((s, it) => s + it.seconds, 0);
    const total = el('p', 'net', 'Total del día');
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
      img.alt = `Foto ${i + 1}`;
      const x = button('×', { rm: i });
      x.setAttribute('aria-label', 'Quitar foto');
      t.append(img, x);
      return t;
    }),
  );
}

function renderDay() {
  const turns = day?.turns || [];
  const lastJudge = turns.findLastIndex((t) => t.role === 'judge');
  const nodes = turns.map((t, i) => (t.role === 'user' ? userBubble(t.text, t.photos) : judgeBubble(t, i === lastJudge)));
  if (dayBusy) {
    if (pendingMine) nodes.push(userBubble(pendingMine.text, pendingMine.photos));
    nodes.push(el('div', 'bubble judge thinking', 'El Guardián está revisando…'));
  }
  $('#d-thread').replaceChildren(...nodes);

  const hasVerdict = turns.at(-1)?.role === 'judge';
  const left = day ? day.maxReplies - day.rounds : 0;
  $('#d-form').hidden = Boolean(day) && (!hasVerdict || left <= 0) && !dayBusy;
  $('#d-text').placeholder = day
    ? 'Replica: explica mejor o sube una prueba…'
    : 'Hoy fui al gym una hora, estudié inglés 2 h y vendí 3 kits por 90 mil…';
  $('#d-send').textContent = day ? 'Replicar' : 'Enviar al Guardián';
  $('#d-send').disabled = dayBusy;
  $('#d-left').textContent = day ? (left === 1 ? 'Te queda 1 réplica.' : `Te quedan ${left} réplicas.`) : '';
  renderThumbs();

  $('#d-actions').hidden = !hasVerdict || dayBusy;
  if (hasVerdict) {
    const accept = $('#d-accept');
    accept.textContent = day.net ? `Aceptar ${signed(day.net)}` : 'Cerrar sin cambios';
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
  if (files.length > room) toast('Máximo 4 fotos por mensaje');
  for (const f of files.slice(0, room)) {
    try {
      dayPhotos.push(await shrink(f));
    } catch {
      toast('No pude leer esa foto');
    }
  }
  renderThumbs();
}

/* ───────── Voz: dictado y lectura con lo que trae el navegador (sin costo) ───────── */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
// Brave expone la API pero no la conecta a ningún servicio: siempre falla con "network".
const IS_BRAVE = typeof navigator.brave !== 'undefined';
const NO_DICTATION =
  'Este navegador no trae dictado (Brave lo bloquea por privacidad). En el celular toca el micrófono del teclado; en el PC abre la app en Chrome, Edge o Safari.';
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
  mic.setAttribute('aria-label', on ? 'Dejar de dictar' : 'Dictar con la voz');
  $('#d-text').placeholder = on ? 'Te escucho…' : day ? 'Replica: explica mejor o sube una prueba…' : 'Hoy fui al gym una hora, estudié inglés 2 h y vendí 3 kits por 90 mil…';
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
    micNote(NO_DICTATION);
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
  r.lang = 'es-CO';
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
        ? 'Permite el micrófono para este sitio y vuelve a intentar.'
        : e.error === 'audio-capture'
          ? 'No encuentro un micrófono conectado.'
          : e.error === 'network'
            ? 'El dictado no pudo conectarse. Revisa tu internet o usa el micrófono del teclado.'
            : 'El dictado falló. Intenta otra vez.',
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
    micNote('No pude abrir el micrófono.');
  }
}

function pickVoice() {
  const voices = synth?.getVoices() || [];
  voice =
    voices.find((v) => /^es[-_]CO/i.test(v.lang)) ||
    voices.find((v) => /^es[-_](MX|US|419)/i.test(v.lang)) ||
    voices.find((v) => /^es/i.test(v.lang)) ||
    null;
}

function speak(text) {
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice?.lang || 'es-CO';
  u.rate = 1.02;
  u.pitch = 0.92;
  synth.speak(u);
}

function spokenDur(s) {
  if (!s) return 'nada';
  const a = Math.abs(s);
  const d = Math.floor(a / DAY), h = Math.floor((a % DAY) / HOUR), m = Math.floor((a % HOUR) / MIN);
  const word = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
  const parts = [
    d && word(d, 'un día', 'días'),
    h && word(h, 'una hora', 'horas'),
    !d && m && word(m, 'un minuto', 'minutos'),
  ].filter(Boolean);
  return `${s > 0 ? 'más' : 'menos'} ${parts.join(' y ')}`;
}

function speakVerdict(turn) {
  const net = turn.items.reduce((sum, it) => sum + it.seconds, 0);
  speak(`${turn.message} Total del día: ${spokenDur(net)}.`);
}

function renderVoiceToggle() {
  const b = $('#d-voice');
  b.setAttribute('aria-pressed', String(Boolean(saved.voice)));
  b.setAttribute('aria-label', saved.voice ? 'Dejar de leer en voz alta' : 'Leer los veredictos en voz alta');
}

function toggleVoice() {
  saved.voice = !saved.voice;
  persist();
  renderVoiceToggle();
  if (saved.voice) {
    // Este toque también "desbloquea" la voz en iPhone para lecturas automáticas posteriores.
    const last = day?.turns.findLast((t) => t.role === 'judge');
    if (last) speakVerdict(last);
    else speak('Listo. Te leo los veredictos del Guardián.');
  } else synth?.cancel();
}

async function sendDay(e) {
  e.preventDefault();
  if (dayBusy) return;
  stopMic();
  const text = $('#d-text').value.trim();
  if (!day && !text) return toast('Cuéntale qué hiciste hoy');
  if (day && !text && !dayPhotos.length) return toast('Escribe tu réplica o sube una prueba');
  const images = dayPhotos.map(({ media_type, data }) => ({ media_type, data }));
  pendingMine = { text, photos: images.length };
  dayBusy = true;
  renderDay();
  try {
    const r = day
      ? await api('POST', `/api/day/${day.id}/reply`, { text, images })
      : await api('POST', '/api/day', { text, images });
    day = r.day;
    saved.day = day;
    persist();
    $('#d-text').value = '';
    dayPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    dayPhotos = [];
    vibrate(12);
    if (saved.voice) speakVerdict(day.turns.at(-1));
  } catch (err) {
    if (err.status === 404 || err.code === 'closed') closeDay();
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
    toast(r.net ? `${signed(r.net)} de vida` : 'Día cerrado sin cambios');
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
  toast('Día descartado');
}

/* ───────── Compartir tiempo: código + QR ───────── */

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
    `<svg viewBox="${-q} ${-q} ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Código QR">` +
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
    ? 'Elige cuánto tiempo regalar.'
    : short
      ? 'No puedes regalar todo tu tiempo.'
      : `Sale de tu reloj ya y te quedan ${fmtDur(after / 1000, 3)}. Si nadie lo recibe en 10 min, vuelve.`;
  $('#sh-preview').classList.toggle('warn', short);
  const create = $('#sh-create');
  create.disabled = !shareAmount || short;
  create.textContent = shareAmount ? `Crear código de ${fmtDur(shareAmount, 3)}` : 'Crear código';
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
  $('#sh-status').textContent = `${fmtDur(shareCode.seconds, 3)} esperando a alguien · expira en ${m}:${String(s).padStart(2, '0')}`;
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
      toast(`¡Entregado! Alguien recibió ${fmtDur(st.seconds, 3)} de tu tiempo.`);
      refresh();
    } else if (st.status === 'devuelto') {
      endCode();
      toast('Nadie lo reclamó: el tiempo volvió a tu reloj.');
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
    toast('Código cancelado: tu tiempo volvió.');
    endCode();
  } catch (err) {
    toast(err.message);
    checkCode();
  }
}

async function claimCode(raw) {
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return toast('El código tiene 6 caracteres');
  try {
    const r = await api('POST', '/api/transfer/claim', { code });
    closeSheet($('#sheet-share'));
    $('#sh-input').value = '';
    apply(r.state);
    clock.flash('gain');
    vibrate([20, 60, 20]);
    toast(`+${fmtDur(r.seconds, 3)}: alguien te regaló tiempo.`);
  } catch (err) {
    toast(err.message);
  }
}

/* ───────── historial ───────── */

function renderHistory() {
  if (!S) return;
  const end = Math.min(now(), S.expiresAt);
  $('#st-earned').textContent = `+${fmtDur(S.earned)}`;
  $('#st-spent').textContent = `−${fmtDur(S.spent)}`;
  $('#st-lived').textContent = fmtDur((end - S.bornAt) / 1000);
  $('#h-title').textContent = `Vida ${S.lifeNo}`;
  const rec = $('#st-record');
  rec.hidden = !S.record;
  if (S.record) rec.textContent = `Récord de vidas anteriores: ${fmtDur(S.record / 1000, 3)}`;

  const items = [];
  let dayName = '';
  for (const t of S.ledger) {
    const label = dayLabel(t.at);
    if (label !== dayName) items.push(el('li', 'day', (dayName = label)));
    const li = el('li', 'item');
    const info = el('span', 'info');
    info.append(el('span', 'note', t.note || labelOf(t)));
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

async function start() {
  const b = $('#btn-start');
  b.disabled = true;
  try {
    const r = await api('POST', '/api/session', { nickname: $('#intro-name').value.trim() });
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

function claimGift() {
  const code = giftCode;
  giftCode = null;
  setTimeout(() => claimCode(code), 600);
}

async function rebirth(force = false) {
  try {
    const r = await api('POST', '/api/rebirth', { force });
    apply(r.state);
    clock.flash('gain');
    vibrate(30);
    toast(`Vida ${r.state.lifeNo}. Tienes ${fmtLong(r.state.initialSeconds)}.`);
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
      // La llave ya no existe en el servidor (base reiniciada o llave inválida).
      saved.token = null;
      S = null;
      closeDay();
      persist();
      renderIntro();
      toast('No encontramos tu reloj. Empieza uno nuevo o usa tu llave.');
    } else if (!err.offline) toast(err.message);
    return false;
  }
}

/* ───────── ajustes ───────── */

const PUSH_TEXT = {
  on: 'Activas: te avisamos a 24 h, 1 h y 10 min del final.',
  off: 'Te avisamos a 24 h, 1 h y 10 min del final, aunque la app esté cerrada.',
  denied: 'Bloqueadas. Actívalas en los ajustes del navegador.',
  ios: 'En iPhone, primero instala la app (Compartir → Agregar a inicio).',
  unsupported: 'Este navegador no soporta alertas.',
};

async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS && !standalone ? 'ios' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
}

async function renderPush() {
  const st = await pushStatus();
  $('#push-status').textContent = PUSH_TEXT[st];
  const b = $('#btn-push');
  b.textContent = st === 'on' ? 'Desactivar' : 'Activar';
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
      toast('Alertas desactivadas');
    } else {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Sin permiso para notificar');
      const { publicKey } = await api('GET', '/api/push/key');
      await current?.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) });
      await api('POST', '/api/push', sub.toJSON());
      toast('Alertas activadas');
    }
  } catch (err) {
    toast(err.message || 'No se pudieron activar las alertas');
  }
  await renderPush();
}

async function syncPush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub && saved.token) await api('POST', '/api/push', sub.toJSON());
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
    hint.textContent = 'Ponla en tu pantalla de inicio. Abre al instante y funciona sin conexión.';
  } else if (isIOS) {
    row.hidden = false;
    $('#btn-install').hidden = true;
    hint.textContent = 'En Safari: Compartir → Agregar a pantalla de inicio.';
  } else row.hidden = true;
}

const maskKey = (k) => (k ? `${k.slice(0, 7)}••••••${k.slice(-4)}` : '');

function openSettings(focusLink = false) {
  $('#key-text').textContent = maskKey(saved.token);
  $('#name-input').value = S?.nickname || '';
  renderNameCount();
  $('#rate-text').textContent = `1 día de vida = ${cop.format(DAY_VALUE)}, un salario mínimo diario (${cop.format(MIN_WAGE)} al mes).`;
  $('#foot').textContent = `Tiempo · ${VERSION}`;
  renderInstall();
  renderPush();
  openSheet($('#sheet-settings'));
  if (focusLink) setTimeout(() => $('#link-input').focus(), 380);
}

/* ───────── tu llave y tu nombre ───────── */

const graphemeCount = (s) =>
  typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(s)].length : s.length;

let keyIsWelcome = false;

function openKeySheet(welcome = false) {
  keyIsWelcome = welcome;
  $('#key-full').textContent = saved.token || '';
  $('#k-title').textContent = welcome ? 'Esta es tu llave' : 'Tu llave';
  $('#k-done').textContent = welcome ? 'Ya la guardé' : 'Listo';
  resetCopyButton();
  openSheet($('#sheet-key'));
}

function resetCopyButton() {
  const b = $('#k-copy');
  b.classList.remove('done');
  b.textContent = 'Copiar llave';
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
    toast('No pude copiarla sola: ya está seleccionada, cópiala tú.');
    return;
  }
  vibrate(15);
  // La confirmación se queda mientras la hoja esté abierta: que no quede duda de que se copió.
  b.classList.add('done');
  b.textContent = '✓ Llave copiada';
  toast('Llave copiada. Pégala en tus notas o en un lugar seguro.');
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
  else toast('Tu tiempo empezó a correr.');
}

function renderNameCount() {
  const n = graphemeCount($('#name-input').value.trim());
  $('#name-count').textContent = `${n}/32`;
}

async function saveName(e) {
  e.preventDefault();
  const input = $('#name-input');
  try {
    apply((await api('PATCH', '/api/me', { nickname: input.value })).state);
    input.value = S.nickname;
    renderNameCount();
    input.blur();
    toast(S.nickname ? `Listo, ${S.nickname}.` : 'Nombre borrado');
  } catch (err) {
    toast(err.message);
  }
}

async function linkKey(e) {
  e.preventDefault();
  const input = $('#link-input');
  const key = input.value.trim();
  if (!/^tk_[\w-]{16,}$/.test(key)) return toast('Esa llave no es válida');
  if (key === saved.token) return toast('Ya estás usando esa llave');
  closeSheet($('#sheet-settings'));
  if (saved.token) {
    const ok = await confirmSheet({
      title: '¿Usar otra llave?',
      text: 'Este dispositivo mostrará ese reloj. Si no guardaste tu llave actual, perderás acceso a este.',
      ok: 'Cambiar',
    });
    if (!ok) return;
  }
  const prev = saved.token;
  saved.token = key;
  try {
    apply(await api('GET', '/api/state'));
    input.value = '';
    closeDay();
    shareCode = null;
    saved.share = null;
    persist();
    toast('Reloj vinculado');
    syncPush();
    if (giftCode) claimGift();
  } catch (err) {
    saved.token = prev;
    persist();
    toast(err.status === 401 ? 'Esa llave no existe' : err.message);
  }
}

async function resetLife() {
  closeSheet($('#sheet-settings'));
  const rem = S ? Math.max(0, S.expiresAt - now()) / 1000 : 0;
  const ok = await confirmSheet({
    title: '¿Empezar de nuevo?',
    text: `Pierdes esta vida${rem ? ` y los ${fmtDur(rem, 3)} que te quedan` : ''}. Renaces con ${fmtLong(S?.initialSeconds || INITIAL)}.`,
    ok: 'Reiniciar',
  });
  if (ok) rebirth(true);
}

/* ───────── service worker ───────── */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Nueva versión desplegada: recarga, pero nunca a mitad de una acción.
    if (hadController && !document.querySelector('dialog[open]')) location.reload();
  });
}

/* ───────── eventos ───────── */

$('#btn-start').addEventListener('click', start);
$('#btn-have-key').addEventListener('click', () => openSettings(true));
$('#btn-day').addEventListener('click', openDay);
$('#btn-money').addEventListener('click', () => openTx('earn'));
$('#btn-share').addEventListener('click', () => openShare());
$('#btn-rebirth').addEventListener('click', () => rebirth(false));
$('#btn-history').addEventListener('click', openHistory);
$('#last').addEventListener('click', openHistory);
$('#btn-settings').addEventListener('click', () => openSettings());

// Plata
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

// Compartir
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

// Ajustes
$('#btn-push').addEventListener('click', togglePush);
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
$('#k-done').addEventListener('click', keyDone);
$('#sheet-key').addEventListener('close', keyClosed);
$('#name-form').addEventListener('submit', saveName);
$('#name-input').addEventListener('input', renderNameCount);
$('#intro-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
$('#link-form').addEventListener('submit', linkKey);
$('#btn-reset').addEventListener('click', resetLife);
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
});
addEventListener('online', refresh);

/* ───────── arranque ───────── */

render(); // pinta al instante con lo guardado; luego sincroniza
registerSW();
navigator.storage?.persist?.().catch(() => {});
if (saved.token) {
  refresh().then((ok) => {
    syncPush();
    if (ok && giftCode) claimGift();
  });
}
