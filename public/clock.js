// Reloj de vida: años · meses · semanas · días · horas · minutos · segundos.
// Solo reescribe los grupos que cambian: 1 actualización por segundo.

const YEAR = 31_536_000; // 365 días
const MONTH = YEAR / 12; // 30 d 10 h, exacto en segundos
const WEEK = 604_800;
const DAY = 86_400;

const GROUPS = [
  ['y', 'años'],
  ['mo', 'meses'],
  ['w', 'sem'],
  ['d', 'días'],
  ['h', 'horas'],
  ['m', 'min'],
  ['s', 'seg'],
];

const p2 = (n) => String(n).padStart(2, '0');

export function split(ms) {
  let t = Math.max(0, Math.ceil(ms / 1000)); // hacia arriba: ceros solo cuando de verdad es cero
  const y = Math.floor(t / YEAR); t -= y * YEAR;
  const mo = Math.floor(t / MONTH); t -= mo * MONTH;
  const w = Math.floor(t / WEEK); t -= w * WEEK;
  const d = Math.floor(t / DAY); t -= d * DAY;
  const h = Math.floor(t / 3600); t -= h * 3600;
  const m = Math.floor(t / 60);
  return { y, mo, w, d, h, m, s: t - m * 60 };
}

export class Clock {
  constructor(host) {
    this.host = host;
    host.innerHTML =
      '<div class="readout">' +
      GROUPS.map(
        ([k, label], i) =>
          (i ? '<span class="colon" aria-hidden="true">:</span>' : '') +
          `<span class="grp"><span class="num" data-k="${k}"></span><span class="unit" aria-hidden="true">${label}</span></span>`,
      ).join('') +
      '</div>';
    this.readout = host.firstElementChild;
    this.nums = Object.fromEntries([...host.querySelectorAll('.num')].map((n) => [n.dataset.k, n]));
    this.vals = {};
    this.minute = -1;
  }

  set(ms) {
    const t = split(ms);
    const text = { y: p2(t.y), mo: p2(t.mo), w: String(t.w), d: String(t.d), h: p2(t.h), m: p2(t.m), s: p2(t.s) };
    for (const k in text) {
      if (this.vals[k] !== text[k]) this.nums[k].textContent = this.vals[k] = text[k];
    }
    this.readout.classList.toggle('beat', t.s % 2 === 0);

    const minute = Math.floor(ms / 60_000);
    if (minute !== this.minute) {
      this.minute = minute;
      const units = [[t.y, 'año', 'años'], [t.mo, 'mes', 'meses'], [t.w, 'semana', 'semanas'], [t.d, 'día', 'días'], [t.h, 'hora', 'horas'], [t.m, 'minuto', 'minutos']];
      const parts = units.filter(([v]) => v).map(([v, one, many]) => `${v} ${v === 1 ? one : many}`);
      this.host.setAttribute('aria-label', parts.length ? `Quedan ${parts.join(', ')}` : 'Tiempo agotado');
    }
  }

  flash(kind) {
    const el = this.host;
    el.classList.remove('gain', 'loss');
    void el.offsetWidth; // reinicia la animación
    el.classList.add(kind);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => el.classList.remove(kind), 800);
  }
}
