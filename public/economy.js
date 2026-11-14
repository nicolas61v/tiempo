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
};

/** Nombre y pista de una categoría en el idioma pedido ('es' o 'en'). */
export const catText = (c, lang) => ({ label: c.label, hint: c.hint, ...(lang === 'en' ? c.en : null) });

export const dayValue = (minWageMonthly) => minWageMonthly / 30;

/** Segundos de vida (con signo) que vale una actividad. */
export function lifeSeconds(category, amount, minWageMonthly) {
  const c = CATEGORIES[category];
  if (!c || !(amount > 0)) return 0;
  const base =
    c.unit === 'money' ? (amount / dayValue(minWageMonthly)) * DAY : c.unit === 'hours' ? amount * HOUR : amount;
  return c.dir * Math.round(base * c.rate);
}
