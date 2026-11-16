import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DICT, ES_STATIC, T, LANG } from '../public/i18n.js';
import { CATEGORIES, catText } from '../public/economy.js';

const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('idiomas: inglés y español tienen exactamente las mismas claves y de la misma forma', () => {
  const en = Object.keys(DICT.en).sort();
  const es = Object.keys(DICT.es).sort();
  assert.deepEqual(es, en);
  for (const k of en) assert.equal(typeof DICT.es[k], typeof DICT.en[k], `forma distinta en "${k}"`);
  for (const k of en) {
    if (typeof DICT.en[k] !== 'string') continue;
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(vars(DICT.es[k]), vars(DICT.en[k]), `variables distintas en "${k}"`);
  }
});

test('idiomas: todo texto fijo del HTML tiene su versión en español', () => {
  const html = read('index.html');
  const keys = [...html.matchAll(/data-i18n(?:-html|-ph|-aria)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 60);
  for (const k of keys) assert.ok(ES_STATIC[k], `falta en ES_STATIC: ${k}`);
});

test('idiomas: cada texto que pide la app existe en el diccionario', () => {
  const app = read('app.js');
  const keys = [...app.matchAll(/\bT\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 100);
  for (const k of keys) assert.ok(k in DICT.en, `falta la clave: ${k}`);
  // las que se arman con variables
  for (const k of ['status.ok', 'status.low', 'status.critical', 'status.dead', 'status.intro']) assert.ok(k in DICT.en, k);
  for (const v of ['aprobado', 'rechazado', 'necesita_prueba', 'no_cuenta']) assert.ok(`verdict.${v}` in DICT.en, v);
  for (const st of ['on', 'off', 'denied', 'ios', 'unsupported']) assert.ok(`push.${st}` in DICT.en, st);
  for (const e of [21600, 43200, 86400]) assert.ok(`remind.${e}` in DICT.en, e);
  for (const m of ['code', 'key']) for (const w of ['title', 'hint', 'other']) assert.ok(`scan.${m}.${w}` in DICT.en, `${m}.${w}`);
});

test('idiomas: inglés por defecto, con variables y plurales', () => {
  assert.equal(LANG, 'en');
  assert.equal(T('life', { n: 3 }), 'Life 3');
  assert.equal(T('unit.week', { n: 1 }), '1 week');
  assert.equal(T('unit.day', { n: 2 }), '2 days');
  assert.equal(T('quota.some', { left: 1, per: 7 }), '1 of 7 chats left today. They reset at midnight.');
  assert.equal(T('clock.left', { y: 0, mo: 0, w: 1, d: 2, h: 0, m: 1 }), '1 week, 2 days, 1 minute left');
  assert.equal(T('speech.dur', { s: -3_600 * 25 }), 'minus one day and one hour');
  assert.equal(T('no.existe'), 'no.existe');
  assert.equal(DICT.es.life.replace('{n}', 3), 'Vida 3');
});

test('idiomas: cada categoría tiene nombre en inglés', () => {
  for (const [k, c] of Object.entries(CATEGORIES)) {
    assert.ok(c.en?.label, `${k} sin nombre en inglés`);
    if (!c.system) assert.ok(c.en.hint, `${k} sin pista en inglés`);
  }
  assert.equal(catText(CATEGORIES.salud, 'en').label, 'Health');
  assert.equal(catText(CATEGORIES.salud, 'es').label, 'Salud');
});

test('idiomas: ?lang=es en el link abre la app en español, lo guarda y se borra de la URL', async () => {
  const saved = new Map();
  const calls = [];
  const prev = { location: globalThis.location, history: globalThis.history, localStorage: globalThis.localStorage };
  const load = async (href, n) => {
    globalThis.location = { href };
    globalThis.history = { state: null, replaceState: (_s, _t, u) => calls.push(u) };
    globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)) };
    return (await import(`../public/i18n.js?caso=${n}`)).LANG;
  };
  try {
    assert.equal(await load('https://app.mylifetime.cc/?lang=es', 1), 'es');
    assert.equal(saved.get('tiempo.lang'), 'es');
    assert.deepEqual(calls, ['/']);
    // La próxima vez, sin el parámetro, sigue en español; y los demás parámetros (la vuelta del pago) no se tocan.
    assert.equal(await load('https://app.mylifetime.cc/', 2), 'es');
    calls.length = 0;
    assert.equal(await load('https://app.mylifetime.cc/?pago=ok&ck=ck_1&lang=en#juicio', 3), 'en');
    assert.deepEqual(calls, ['/?pago=ok&ck=ck_1#juicio']);
    // Un idioma que no existe se ignora (y se limpia de la URL).
    calls.length = 0;
    assert.equal(await load('https://app.mylifetime.cc/?lang=fr', 4), 'en');
    assert.deepEqual(calls, ['/']);
  } finally {
    Object.assign(globalThis, prev);
  }
});
