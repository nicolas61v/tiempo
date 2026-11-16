// Economía del tiempo: la usan el servidor (que decide) y la app (que muestra la vista previa).
//
// Un solo axioma: 1 DÍA DE VIDA = 1 SALARIO MÍNIMO DIARIO (SMMLV / 30).
// Vivir cuesta 1 día por día: el reloj corre solo, así que el tiempo que "se fue" ya está cobrado.
// Lo que suma o resta encima de eso se traduce a esa misma moneda.

export const DAY = 86_400;
export const HOUR = 3_600;

/**
 * dir:    +1 gana, −1 gasta
 * unit:   'money' (pesos), 'hours' (horas de actividad) o 'seconds' (tiempo directo)
 * rate:   multiplicador sobre la conversión base
 * cap:    máximo de horas que cuentan en 24 h (anti-trampa)
 * proof:  'none'  → se registra en tu palabra (botón Dinero)
 *         'photo' → solo por "Mi día": el Guardián exige foto
 *         'judge' → solo por "Mi día": el Guardián decide, foto opcional
 * system: movimientos internos (transferencias), no se eligen a mano
 * label/hint: en español; en: { label, hint } en inglés (ver catText)
 */
export const CATEGORIES = {
  // ── Ganar ──
  ingreso: { dir: 1, unit: 'money', rate: 1, proof: 'none', label: 'Dinero', hint: 'Lo que te entra limpio: ventas, sueldo, freelance.',
    en: { label: 'Money', hint: 'What comes in clean: sales, salary, freelance.' } },
  inversion: { dir: 1, unit: 'money', rate: 0.5, proof: 'none', label: 'Inversión en ti', hint: 'Plata que pones en crecer: cursos, libros, herramientas.',
    en: { label: 'Investing in you', hint: 'Money you put into growing: courses, books, tools.' } },
  aprendizaje: { dir: 1, unit: 'hours', rate: 2, cap: 8, proof: 'photo', label: 'Aprendizaje', hint: 'Estudiar o practicar algo que te hace más capaz.',
    en: { label: 'Learning', hint: 'Studying or practicing something that makes you more capable.' } },
  salud: { dir: 1, unit: 'hours', rate: 3, cap: 2, proof: 'photo', label: 'Salud', hint: 'Ejercicio y deporte.',
    en: { label: 'Health', hint: 'Exercise and sports.' } },
  proyecto: { dir: 1, unit: 'hours', rate: 1, cap: 10, proof: 'judge', label: 'Proyecto', hint: 'Trabajo enfocado en lo tuyo que todavía no paga.',
    en: { label: 'Project', hint: "Focused work on your own thing that doesn't pay yet." } },
  // ── Gastar ──
  consumo: { dir: -1, unit: 'money', rate: 1, proof: 'none', label: 'Gasto', hint: 'Lo que no necesitabas: antojos, compras por impulso.',
    en: { label: 'Spending', hint: "What you didn't need: cravings, impulse buys." } },
  // ── Transferencias ──
  envio: { dir: -1, unit: 'seconds', rate: 1, system: true, label: 'Tiempo enviado', en: { label: 'Time sent' } },
  recibo: { dir: 1, unit: 'seconds', rate: 1, system: true, label: 'Tiempo recibido', en: { label: 'Time received' } },
  // ── Pagos (bought: comprado con dinero real; nunca cuenta en el ranking) ──
  compra: { dir: 1, unit: 'seconds', rate: 1, system: true, bought: true, label: 'Tiempo comprado', en: { label: 'Bought time' } },
  revivir: { dir: 1, unit: 'seconds', rate: 1, system: true, bought: true, label: 'Revivir', en: { label: 'Revive' } },
  regalo: { dir: 1, unit: 'seconds', rate: 1, system: true, bought: true, label: 'Regalo comprado', en: { label: 'Bought gift' } },
  reembolso: { dir: -1, unit: 'seconds', rate: 1, system: true, bought: true, label: 'Reembolso', en: { label: 'Refund' } },
  // ── Juicios (rank: la condena sí descuenta en el ranking) ──
  juicio: { dir: -1, unit: 'seconds', rate: 1, system: true, rank: true, label: 'Condena del jurado', en: { label: 'Jury sentence' } },
  // ── Premio del jurado: parte de lo que estaba en juego, o 1 día por votar bien a un inocente (no cuenta en el ranking) ──
  jurado: { dir: 1, unit: 'seconds', rate: 1, system: true, label: 'Premio del jurado', en: { label: 'Jury reward' } },
  // ── Faltas: subir contenido sexual cuesta vida (1 día, 1 semana, 1 mes…) ──
  sancion: { dir: -1, unit: 'seconds', rate: 1, system: true, rank: true, label: 'Falta: contenido prohibido', en: { label: 'Strike: forbidden content' } },
};

/** "¿A qué te dedicas?": lo que cada quien cuenta de sí en su perfil (lo revisa el Guardián). */
export const BIO_MAX = 160;

/**
 * Potestad para citar a juicio según el tiempo vivido de verdad (todas tus vidas, sin los ratos en cero;
 * no el tiempo ganado). Con menos de 15 días no se puede. Un juicio se abre al sumar 3 de potestad.
 */
export const ACCUSE_POWER = [
  { days: 15, power: 1 },
  { days: 30, power: 2 },
  { days: 90, power: 3 },
];
export const powerOf = (livedSeconds) => ACCUSE_POWER.findLast((p) => livedSeconds >= p.days * 86_400)?.power ?? 0;

/** Faltas por contenido sexual: lo que cuesta cada una, en días. Nunca se borran; de la quinta en adelante, un año. */
export const STRIKE_DAYS = [1, 7, 30, 90, 365];
export const strikeSeconds = (n) => STRIKE_DAYS[Math.min(n, STRIKE_DAYS.length - 1)] * 86_400;

/** Categorías que suman dinero (en tu palabra o con el Guardián) y las que se miden en horas. */
export const MONEY_CATS = ['ingreso', 'inversion'];
export const HOUR_CATS = ['aprendizaje', 'salud', 'proyecto'];

/**
 * Límites de lo que se gana por dinero, en días de vida por ventana de 7 días (el dinero llega a montones:
 * un sueldo, una venta grande; por eso la ventana es semanal y no diaria).
 * word: lo que entra en tu palabra mientras el Guardián no haya verificado tus ingresos.
 * cap:  el tope para todos, verificado o no. Nadie gana más que esto por dinero.
 */
export const MONEY = { windowDays: 7, wordDays: 7, capDays: 30 };

/** Horas despierto que caben en un día: la suma de estudio + ejercicio + proyecto nunca pasa de aquí en 24 h. */
export const HOURS_PER_DAY = 16;

/** Ligas del ranking según el tiempo que te queda (sin contar lo comprado). Nombres en i18n: league.<id>. */
export const LEAGUES = [
  { id: 'bronce', min: 0 },
  { id: 'plata', min: 14 * 86_400 },
  { id: 'oro', min: 30 * 86_400 },
  { id: 'platino', min: 90 * 86_400 },
  { id: 'diamante', min: 180 * 86_400 },
  { id: 'inmortal', min: 365 * 86_400 },
];
export const leagueOf = (seconds) => LEAGUES.findLast((l) => seconds >= l.min).id;

/** Nombre y pista de una categoría en el idioma pedido ('es' o 'en'). */
export const catText = (c, lang) => ({ label: c.label, hint: c.hint, ...(lang === 'en' ? c.en : null) });

export const dayValue = (minWageMonthly) => minWageMonthly / 30;

/**
 * 1 día de vida = 1 día de salario mínimo DEL PAÍS DONDE VIVES. Por ahora hay dos:
 * - Colombia: el SMMLV (mensual, en pesos).
 * - Estados Unidos: un salario por hora (US$14 por defecto) × 40 h × 52 semanas / 12 → mensual.
 * Los demás países usan, por ahora, el de Colombia. Todo se devuelve en pesos colombianos al mes, que es la
 * unidad de la economía (quien usa dólares los ve convertidos con USD_COP).
 */
export const US_HOURS_PER_MONTH = (40 * 52) / 12;
export const wageCountry = (country) => (country === 'US' ? 'US' : 'CO');
export function wageFor(country, { co = 1_750_905, usHourly = 14, usdCop = 4000 } = {}) {
  return wageCountry(country) === 'US' ? usHourly * US_HOURS_PER_MONTH * usdCop : co;
}

/** Segundos de vida (con signo) que vale una actividad. */
export function lifeSeconds(category, amount, minWageMonthly) {
  const c = CATEGORIES[category];
  if (!c || !(amount > 0)) return 0;
  const base =
    c.unit === 'money' ? (amount / dayValue(minWageMonthly)) * DAY : c.unit === 'hours' ? amount * HOUR : amount;
  return c.dir * Math.round(base * c.rate);
}
