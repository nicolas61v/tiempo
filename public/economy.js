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
 * proof:  'none'  → se registra en tu palabra (botón Plata)
 *         'photo' → solo por "Mi día": el Guardián exige foto
 *         'judge' → solo por "Mi día": el Guardián decide, foto opcional
 * system: movimientos internos (transferencias), no se eligen a mano
 */
export const CATEGORIES = {
  // ── Ganar ──
  ingreso: { dir: 1, unit: 'money', rate: 1, proof: 'none', label: 'Dinero', hint: 'Lo que te entra limpio: ventas, sueldo, freelance.' },
  inversion: { dir: 1, unit: 'money', rate: 0.5, proof: 'none', label: 'Inversión en ti', hint: 'Plata que pones en crecer: cursos, libros, herramientas.' },
  aprendizaje: { dir: 1, unit: 'hours', rate: 2, cap: 8, proof: 'photo', label: 'Aprendizaje', hint: 'Estudiar o practicar algo que te hace más capaz.' },
  salud: { dir: 1, unit: 'hours', rate: 3, cap: 2, proof: 'photo', label: 'Salud', hint: 'Ejercicio y deporte.' },
  proyecto: { dir: 1, unit: 'hours', rate: 1, cap: 10, proof: 'judge', label: 'Proyecto', hint: 'Trabajo enfocado en lo tuyo que todavía no paga.' },
  // ── Gastar ──
  consumo: { dir: -1, unit: 'money', rate: 1, proof: 'none', label: 'Gasto', hint: 'Lo que no necesitabas: antojos, compras por impulso.' },
  // ── Transferencias ──
  envio: { dir: -1, unit: 'seconds', rate: 1, system: true, label: 'Tiempo enviado' },
  recibo: { dir: 1, unit: 'seconds', rate: 1, system: true, label: 'Tiempo recibido' },
};

export const dayValue = (minWageMonthly) => minWageMonthly / 30;

/** Segundos de vida (con signo) que vale una actividad. */
export function lifeSeconds(category, amount, minWageMonthly) {
  const c = CATEGORIES[category];
  if (!c || !(amount > 0)) return 0;
  const base =
    c.unit === 'money' ? (amount / dayValue(minWageMonthly)) * DAY : c.unit === 'hours' ? amount * HOUR : amount;
  return c.dir * Math.round(base * c.rate);
}
