import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openStore, alertBand, MIGRATIONS } from '../server/store.js';
import { buildContent } from '../server/judge.js';
import { lifeSeconds } from '../public/economy.js';
import { split } from '../public/clock.js';

const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const SUB = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
// Salario de prueba redondo: 3.000.000 al mes → 1 día de vida = $100.000
const WAGE = 3_000_000;
const PHOTO = { media_type: 'image/jpeg', data: 'A'.repeat(200) };

function setup() {
  let t = Date.UTC(2026, 10, 12, 12);
  const store = openStore({ initialSeconds: 7 * 86_400, minWage: WAGE, now: () => t });
  const { token, state } = store.createUser();
  return { store, token, state, id: store.auth(token).id, now: () => t, advance: (ms) => (t += ms) };
}
const add = (store, id, category, amount, note) => store.addTx(id, { category, amount, note });
const item = (category, amount, verdict = 'aprobado', activity = category) => ({ activity, category, amount, verdict, reason: '' });
const verdict = (...items) => ({ message: 'Visto.', items });

/* ───────── reloj y fórmula ───────── */

test('nace con una semana exacta', () => {
  const { token, state } = setup();
  assert.match(token, /^tk_[\w-]{24}$/);
  assert.equal(state.expiresAt - state.now, 7 * DAY);
  assert.equal(state.lifeNo, 1);
});

test('cambiar la llave: la nueva abre el mismo reloj, la vieja ya no, y el tiempo no cambia', () => {
  const { store, token, id, state } = setup();
  add(store, id, 'ingreso', 100_000, 'Venta');
  const before = store.state(id);
  const r = store.rotateToken(id);
  assert.match(r.token, /^tk_[\w-]{24}$/);
  assert.notEqual(r.token, token);
  assert.equal(store.auth(token), null);
  assert.equal(store.auth(r.token).id, id);
  assert.equal(r.state.expiresAt, before.expiresAt);
  assert.equal(r.state.bornAt, state.bornAt);
  assert.deepEqual(r.state.ledger, before.ledger);
});

test('la llave autentica; una falsa no', () => {
  const { store, token, id } = setup();
  assert.equal(store.auth(token).id, id);
  assert.equal(store.auth('tk_falsa_000000000000000000'), null);
  assert.equal(store.auth(undefined), null);
});

test('fórmula: 1 día de vida = 1 salario mínimo diario', () => {
  const h = (cat, amount) => lifeSeconds(cat, amount, WAGE) / 3600;
  assert.equal(h('ingreso', 100_000), 24); // un mínimo diario → +1 día
  assert.equal(h('inversion', 100_000), 12); // inversión en ti → medio día
  assert.equal(h('aprendizaje', 1), 2);
  assert.equal(h('salud', 1), 3);
  assert.equal(h('proyecto', 2), 2);
  assert.equal(h('consumo', 50_000), -12); // gasto impulsivo → −medio día
  assert.equal(h('recibo', 3600), 1);
});

test('a mano solo entra la plata; lo demás pasa por el Guardián', () => {
  const { store, id, state } = setup();
  const { state: s } = add(store, id, 'ingreso', 200_000, 'Venta Yesti');
  assert.equal(s.expiresAt, state.expiresAt + 2 * DAY);
  assert.deepEqual(
    { note: s.ledger[0].note, category: s.ledger[0].category, amount: s.ledger[0].amount, status: s.ledger[0].status },
    { note: 'Venta Yesti', category: 'ingreso', amount: 200_000, status: 'declarado' },
  );
  assert.throws(() => add(store, id, 'salud', 1), { code: 'needs_judge' });
  assert.throws(() => add(store, id, 'aprendizaje', 1), { code: 'needs_judge' });
  assert.throws(() => add(store, id, 'recibo', 3600), { code: 'category' });
  assert.throws(() => add(store, id, 'perdido', 2), { code: 'category' });
});

test('no se puede gastar más de lo que queda ni datos inválidos', () => {
  const { store, id } = setup();
  assert.throws(() => add(store, id, 'consumo', 1_000_000), { code: 'insufficient' }); // 10 días > 7
  assert.throws(() => add(store, id, 'ingreso', 0), { code: 'amount' });
  assert.throws(() => add(store, id, 'ingreso', -5), { code: 'amount' });
  assert.throws(() => add(store, id, 'ingreso', 'mucho'), { code: 'amount' });
});

test('al llegar a cero muere y solo puede renacer', () => {
  const { store, id, advance } = setup();
  assert.throws(() => store.rebirth(id), { code: 'alive' });
  advance(7 * DAY);
  assert.throws(() => add(store, id, 'ingreso', 100_000), { code: 'dead' });
  const { state } = store.rebirth(id);
  assert.equal(state.lifeNo, 2);
  assert.equal(state.expiresAt - state.now, 7 * DAY);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.record, 7 * DAY);
});

test('deshacer solo dentro de 5 minutos', () => {
  const { store, id, state, advance } = setup();
  const { tx } = add(store, id, 'ingreso', 10_000);
  assert.equal(store.undoTx(id, tx.id).state.expiresAt, state.expiresAt);
  const late = add(store, id, 'ingreso', 10_000).tx;
  advance(6 * MIN);
  assert.throws(() => store.undoTx(id, late.id), { code: 'too_late' });
});

/* ───────── Mi día con el Guardián ───────── */

test('mi día: solo suma lo aprobado, respeta topes e ignora categorías inventadas', () => {
  const { store, id, state } = setup();
  const { id: dayId } = store.openDay(id, { text: 'gym 3h, inglés 1h, series 2h, 50 mil en antojos' });
  store.saveVerdict(dayId, verdict(
    item('salud', 3), // tope de 2 h → +6 h
    item('aprendizaje', 1, 'necesita_prueba'), // sin foto: no suma
    item('ninguna', 0, 'no_cuenta'), // series: ese tiempo ya pasó
    item('consumo', 50_000), // −12 h
    item('envio', 999), // la IA no puede tocar categorías del sistema
  ));
  const pub = store.publicDay(id, dayId);
  assert.equal(pub.net, -6 * 3600);
  assert.equal(pub.turns[1].items[0].capped, true);
  assert.equal(pub.turns[1].items[4].category, 'ninguna');

  const { state: s } = store.acceptDay(id, dayId);
  assert.equal(s.expiresAt, state.expiresAt - 6 * HOUR);
  const salud = s.ledger.find((r) => r.category === 'salud');
  assert.equal(salud.amount, 2);
  assert.equal(salud.status, 'verificado');
  assert.equal(s.ledger.find((r) => r.category === 'consumo').status, 'aprobado');
  assert.throws(() => store.acceptDay(id, dayId), { code: 'closed' });
});

test('mi día: máximo 2 réplicas, y si la IA falla se puede reintentar', () => {
  const { store, id } = setup();
  const { id: dayId } = store.openDay(id, { text: 'estudié' });
  assert.throws(() => store.replyDay(id, dayId, { text: '¿y?' }), { code: 'waiting' });
  store.saveVerdict(dayId, verdict());
  store.replyDay(id, dayId, { text: 'réplica 1' });
  store.rollbackDay(dayId); // la IA no respondió
  assert.equal(store.publicDay(id, dayId).rounds, 0);
  store.replyDay(id, dayId, { text: 'réplica 1', images: [PHOTO] });
  store.saveVerdict(dayId, verdict());
  store.replyDay(id, dayId, { text: 'réplica 2' });
  store.saveVerdict(dayId, verdict());
  assert.throws(() => store.replyDay(id, dayId, { text: 'réplica 3' }), { code: 'final' });
});

test('mi día: una foto solo sirve de prueba una vez', () => {
  const { store, id } = setup();
  const a = store.openDay(id, { text: 'gym', images: [PHOTO] }).id;
  assert.equal(store.judgeInput(id, a).images[0].reused, false);
  store.saveVerdict(a, verdict());
  store.acceptDay(id, a);
  const b = store.openDay(id, { text: 'gym otra vez', images: [PHOTO] }).id;
  assert.equal(store.judgeInput(id, b).images[0].reused, true);
  assert.throws(() => store.openDay(id, { text: 'x', images: [{ media_type: 'text/html', data: 'A'.repeat(200) }] }), { code: 'images' });
});

test('mi día: la conversación que ve la IA', () => {
  const content = buildContent({
    turns: [
      { role: 'user', text: 'fui al gym', photos: 1 },
      { role: 'judge', verdict: verdict(item('salud', 1)) },
      { role: 'user', text: 'mira esta otra', photos: 1 },
    ],
    images: [PHOTO, { ...PHOTO, reused: true }],
  });
  assert.equal(content.filter((b) => b.type === 'image').length, 2);
  const text = content.at(-1).text;
  assert.match(text, /fui al gym/);
  assert.match(text, /Réplica 1 de 2 \[adjuntó la foto 2\]/);
  assert.match(content[2].text, /ya se usó/);
});

/* ───────── compartir tiempo ───────── */

test('compartir: el tiempo sale al crear el código y llega al reclamarlo', () => {
  const { store, id, state } = setup();
  const other = store.createUser();
  const id2 = store.auth(other.token).id;
  const { transfer, state: s1 } = store.createTransfer(id, 3600);
  assert.match(transfer.code, /^[A-Z2-9]{6}$/);
  assert.equal(s1.expiresAt, state.expiresAt - HOUR);
  assert.throws(() => store.claimTransfer(id, transfer.code), { code: 'own' });
  const r = store.claimTransfer(id2, transfer.code.toLowerCase());
  assert.equal(r.seconds, 3600);
  assert.equal(r.state.expiresAt, other.state.expiresAt + HOUR);
  assert.throws(() => store.claimTransfer(id2, transfer.code), { code: 'code' }); // un solo uso
  assert.equal(store.transferStatus(id, transfer.code).status, 'entregado');
  assert.throws(() => store.undoTx(id, s1.ledger[0].id), { code: 'system' });
});

test('compartir: en el historial de cada uno queda con quién fue', () => {
  const { store, id } = setup();
  store.setNickname(id, 'Nico');
  const pipe = store.createUser({ nickname: 'Pipe' });
  const id2 = store.auth(pipe.token).id;
  const { transfer } = store.createTransfer(id, 3600);
  assert.equal(store.state(id).ledger[0].note, `Código ${transfer.code}`); // mientras nadie lo reclama
  const r = store.claimTransfer(id2, transfer.code);
  assert.equal(r.fromName, 'Nico');
  const sent = store.state(id).ledger[0];
  const got = r.state.ledger[0];
  assert.deepEqual([sent.note, sent.category, sent.seconds], ['Para Pipe', 'envio', -3600]);
  assert.deepEqual([got.note, got.category, got.seconds], ['De Nico', 'recibo', 3600]);
  assert.equal(store.transferStatus(id, transfer.code).toName, 'Pipe');

  const anon = store.createUser(); // sin nombre
  const t2 = store.createTransfer(id2, 600).transfer;
  store.claimTransfer(store.auth(anon.token).id, t2.code);
  assert.equal(store.state(id2).ledger[0].note, 'Para alguien');
});

test('compartir: cancelar devuelve y los códigos vencidos vuelven solos', () => {
  const { store, id, state, now, advance } = setup();
  const a = store.createTransfer(id, 3600).transfer;
  const b = store.createTransfer(id, 1800).transfer;
  assert.equal(store.cancelTransfer(id, b.code).state.expiresAt, state.expiresAt - HOUR);
  advance(11 * MIN);
  assert.equal(store.expireTransfers(now()), 1);
  assert.equal(store.state(id).expiresAt, state.expiresAt);
  assert.equal(store.transferStatus(id, a.code).status, 'devuelto');
  assert.throws(() => store.createTransfer(id, 7 * 86_400), { code: 'insufficient' }); // no se regala todo
  assert.throws(() => store.claimTransfer(id, '12'), { code: 'code' });
});

/* ───────── actualizaciones: nunca tocan los relojes ───────── */

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tiempo-test-'));

test('un deploy (reabrir la base con el código nuevo) deja cada reloj exactamente igual', () => {
  const dir = tmpDir();
  const t = Date.UTC(2026, 10, 12, 12);
  const a = openStore({ dir, minWage: WAGE, now: () => t });
  const { token } = a.createUser({ nickname: 'Nico' });
  a.addTx(a.auth(token).id, { category: 'ingreso', amount: 100_000, note: 'Venta' });
  const before = a.state(a.auth(token).id);
  a.close();

  const b = openStore({ dir, minWage: WAGE, now: () => t });
  const after = b.state(b.auth(token).id); // la misma llave sigue funcionando
  assert.deepEqual(
    { expiresAt: after.expiresAt, lifeNo: after.lifeNo, bornAt: after.bornAt, nickname: after.nickname, ledger: after.ledger },
    { expiresAt: before.expiresAt, lifeNo: before.lifeNo, bornAt: before.bornAt, nickname: before.nickname, ledger: before.ledger },
  );
  assert.equal(b.backupFile, null); // sin migraciones pendientes no hace falta copia
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('si hay migración pendiente, primero se guarda una copia completa de la base', () => {
  const dir = tmpDir();
  // La base exactamente como estaba en la versión anterior: todas las migraciones menos la última.
  const raw = new DatabaseSync(path.join(dir, 'tiempo.db'));
  for (const sql of MIGRATIONS.slice(0, -1)) raw.exec(sql);
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  const token = 'tk_prueba_de_migracion_0000000';
  const expires = Date.UTC(2026, 10, 20);
  raw
    .prepare('INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at) VALUES (?, ?, 1, 1, 1, ?)')
    .run('u1', createHash('sha256').update(token).digest('base64url'), expires);
  raw.close();

  const b = openStore({ dir, minWage: WAGE });
  assert.ok(b.backupFile && fs.existsSync(b.backupFile));
  assert.equal(b.state(b.auth(token).id).expiresAt, expires); // migrado sin tocar el reloj
  b.close();
  const copy = new DatabaseSync(b.backupFile, { readOnly: true });
  assert.equal(copy.prepare('SELECT expires_at FROM users').get().expires_at, expires); // la copia tiene el reloj
  copy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migración v6: borra nombres que son una llave, sin tocar el reloj', () => {
  const dir = tmpDir();
  const raw = new DatabaseSync(path.join(dir, 'tiempo.db'));
  for (const sql of MIGRATIONS.slice(0, 5)) raw.exec(sql); // la base como estaba en v5
  raw.exec('PRAGMA user_version = 5');
  const token = 'tk_hermano_000000000000000000';
  const expires = Date.UTC(2026, 10, 20);
  raw
    .prepare('INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at, nickname) VALUES (?, ?, 1, 1, 1, ?, ?)')
    .run('u1', createHash('sha256').update(token).digest('base64url'), expires, 'tk_PRUEBAprueba0000000000xx');
  raw.close();

  const store = openStore({ dir, minWage: WAGE });
  const s = store.state(store.auth(token).id);
  assert.equal(s.nickname, '');
  assert.equal(s.expiresAt, expires);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ───────── nombre o apodo ───────── */

test('nombre o apodo: opcional, máximo 32 caracteres, limpio y editable', () => {
  const store = openStore({ minWage: WAGE });
  const { token, state } = store.createUser({ nickname: '  Nico   el  del\ttiempo  ' });
  assert.equal(state.nickname, 'Nico el del tiempo');
  const id = store.auth(token).id;
  assert.equal(store.setNickname(id, 'x'.repeat(40)).state.nickname, 'x'.repeat(32));
  assert.equal(store.setNickname(id, '⏳'.repeat(40)).state.nickname, '⏳'.repeat(32)); // un emoji = un carácter
  assert.equal(store.setNickname(id, 'Ana\u202Eloc\u0007\u200B').state.nickname, 'Analoc'); // sin trucos invisibles
  assert.equal(store.setNickname(id, 'tk_PRUEBAprueba0000000000xx').state.nickname, ''); // pegó su llave en el nombre
  assert.equal(store.setNickname(id, 'Pipe tk_PRUEBAprueba0000000000xx').state.nickname, 'Pipe');
  assert.equal(store.setNickname(id, '').state.nickname, '');
  assert.equal(store.setNickname(id, 42).state.nickname, '');
  assert.equal(store.createUser().state.nickname, '');
});

/* ───────── anti-abuso: cuentas repetidas y vidas aprovechadas ───────── */

test('anti-abuso: agrupa por teléfono y por red sin guardar la IP, y separa reinicios de muertes', () => {
  let t = Date.UTC(2026, 10, 12, 12);
  const store = openStore({ minWage: WAGE, now: () => t });
  const a = store.createUser({ nickname: 'Ana', deviceId: 'dev-1111-aaaa', ip: '181.50.10.20' });
  store.createUser({ nickname: 'Ana2', deviceId: 'dev-1111-aaaa', ip: '181.50.10.20' }); // mismo teléfono
  store.createUser({ nickname: 'Beto', deviceId: 'dev-2222-bbbb', ip: '::ffff:181.50.10.20' }); // otra persona, misma red
  store.createUser({ nickname: 'Caro', deviceId: '<script>', ip: '' }); // identificador inválido → se ignora

  const id = store.auth(a.token).id;
  store.rebirth(id, true); // reinicio teniendo tiempo
  t += 8 * DAY;
  store.rebirth(id); // se le acabó y renació

  const s = store.adminStats(t);
  assert.equal(s.totales.relojes, 4);
  assert.equal(s.totales.dispositivos, 2);
  assert.deepEqual(s.dispositivosConVariasCuentas.map((g) => [g.cuentas, g.nombres.sort().join(',')]), [[2, 'Ana,Ana2']]);
  assert.deepEqual(s.redesConVariasCuentas.map((g) => g.cuentas), [3]); // ::ffff:IPv4 = misma red
  const ana = s.relojes.find((r) => r.nombre === 'Ana');
  assert.deepEqual([ana.vida, ana.reinicios, ana.muertes], [3, 1, 1]);
  assert.deepEqual([s.totales.reinicios, s.totales.muertes], [1, 1]);
  assert.ok(!JSON.stringify(s).includes('181.50'), 'la IP nunca aparece');
  assert.ok(!JSON.stringify(s).includes('dev-1111-aaaa'), 'el identificador completo tampoco');
});

/* ───────── alertas ───────── */

test('bandas de alerta', () => {
  assert.equal(alertBand(2 * DAY), null);
  assert.equal(alertBand(20 * HOUR), 86_400);
  assert.equal(alertBand(30 * MIN), 3_600);
  assert.equal(alertBand(5 * MIN), 600);
  assert.equal(alertBand(0), 0);
});

test('alertas: una por umbral, solo con suscripción, se rearman al ganar', () => {
  const { store, id, now, advance } = setup();
  const bands = () => store.claimAlerts(now()).map((a) => a.band);
  advance(6 * DAY + MIN); // quedan < 24 h
  assert.deepEqual(bands(), []); // sin suscripción no hay nada que avisar
  store.addSub(id, SUB);
  assert.deepEqual(bands(), [86_400]);
  assert.deepEqual(bands(), []); // no repite
  advance(23 * HOUR); // < 1 h
  assert.deepEqual(bands(), [3_600]);
  add(store, id, 'ingreso', 200_000); // gana 2 días (quedan 2d 59m): se rearma
  assert.deepEqual(bands(), []);
  advance(DAY + 2 * HOUR); // quedan 22h 59m
  assert.deepEqual(bands(), [86_400]);
  advance(DAY); // muere
  assert.deepEqual(bands(), [0]);
  assert.deepEqual(bands(), []);
});

/* ───────── recordatorio de "Mi día" ───────── */

test('recordatorio: si en 12 h no le cuentas nada al Guardián te lo recuerda, nunca de noche', () => {
  const { store, id, advance, now } = setup(); // nace a las 07:00 de Bogotá
  assert.equal(store.state(id).remindEvery, 43_200); // por defecto, cada 12 h
  advance(13 * HOUR);
  assert.deepEqual(store.claimReminders(now()), []); // sin alertas activadas no hay a quién avisar

  store.addSub(id, SUB);
  const at = (hours) => { advance(hours * HOUR); return store.claimReminders(now()).map((r) => r.userId); };
  assert.deepEqual(at(0), [id]); // 20:00: 13 h sin contarle nada
  assert.deepEqual(at(0), []); // uno solo, no uno por barrido
  assert.deepEqual(at(11.5), []); // 07:30: aún no van 12 h
  assert.deepEqual(at(0.5), [id]); // 08:00: 12 h y ya es de día

  advance(6 * HOUR); // 14:00: le cuenta su día → la cuenta arranca de nuevo
  store.openDay(id, { text: 'gym una hora' });
  assert.deepEqual(at(6), []); // 20:00: 12 h desde el recordatorio, pero solo 6 h desde que le contó
  assert.deepEqual(at(7), []); // 03:00: 13 h, de noche
  assert.deepEqual(at(5), [id]); // 08:00

  const before = store.state(id).expiresAt;
  store.setReminder(id, 0);
  assert.deepEqual(at(48), []); // apagado
  assert.equal(store.state(id).expiresAt, before); // recordar nunca toca el reloj
  assert.throws(() => store.setReminder(id, 3600), { code: 'remind' });
  assert.throws(() => store.setReminder(id, '43200'), { code: 'remind' });
});

test('recordatorio: cada 6 h, en la hora del teléfono, y nunca a un reloj en cero', () => {
  const { store, id, advance, now } = setup(); // 12:00 UTC
  store.addSub(id, { ...SUB, tz: 'Asia/Tokyo' }); // la zona llega al activar las alertas
  assert.equal(store.setReminder(id, 21_600, 'Zona/Inventada').state.remindEvery, 21_600); // zona inválida: se ignora
  const at = (hours) => { advance(hours * HOUR); return store.claimReminders(now()).length; };
  assert.equal(at(5), 0); // 17:00 UTC = 02:00 en Tokio: aún no van 6 h
  assert.equal(at(1), 0); // 03:00 en Tokio: de noche
  assert.equal(at(5), 1); // 08:00 en Tokio
  assert.equal(at(6), 1); // 14:00
  assert.equal(at(6), 1); // 20:00
  assert.equal(at(6), 0); // 02:00
  advance(7 * DAY); // el reloj llega a cero
  assert.equal(store.state(id).expiresAt <= now(), true);
  assert.equal(at(12), 0);
});

test('migración v7: recordatorio cada 12 h por defecto, sin tocar el reloj', () => {
  const dir = tmpDir();
  const raw = new DatabaseSync(path.join(dir, 'tiempo.db'));
  for (const sql of MIGRATIONS.slice(0, 6)) raw.exec(sql); // la base como estaba en v6
  raw.exec('PRAGMA user_version = 6');
  const token = 'tk_hermano_000000000000000000';
  const expires = Date.UTC(2026, 10, 20, 6, 32, 11);
  raw
    .prepare('INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at, nickname) VALUES (?, ?, 1, 1, 1, ?, ?)')
    .run('u1', createHash('sha256').update(token).digest('base64url'), expires, 'Nico');
  raw.close();

  const store = openStore({ dir, minWage: WAGE });
  const s = store.state(store.auth(token).id);
  assert.equal(s.expiresAt, expires);
  assert.equal(s.nickname, 'Nico');
  assert.equal(s.remindEvery, 43_200);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migración v8: transferencias pasadas con nombre en el historial, sin tocar relojes ni montos', () => {
  const dir = tmpDir();
  const raw = new DatabaseSync(path.join(dir, 'tiempo.db'));
  for (const sql of MIGRATIONS.slice(0, 7)) raw.exec(sql); // la base como estaba en v7
  raw.exec('PRAGMA user_version = 7');
  const tok = (n) => `tk_${n}_00000000000000000000000`;
  const hash = (t) => createHash('sha256').update(t).digest('base64url');
  const user = raw.prepare('INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at, nickname) VALUES (?, ?, 1, 1, 1, ?, ?)');
  user.run('nico', hash(tok('nico')), 5_000_000, 'Nico');
  user.run('pipe', hash(tok('pipe')), 6_000_000, ''); // sin nombre
  const tx = raw.prepare('INSERT INTO ledger (user_id, life_no, at, seconds, note, category, amount, status) VALUES (?, 1, 2, ?, ?, ?, ?, ?)');
  const sent = tx.run('nico', -3600, 'Código ABC234', 'envio', 3600, 'enviado').lastInsertRowid;
  tx.run('pipe', 3600, 'Código ABC234', 'recibo', 3600, 'recibido');
  const pending = tx.run('nico', -600, 'Código XYZ789', 'envio', 600, 'enviado').lastInsertRowid;
  const tr = raw.prepare('INSERT INTO transfers (code, from_user, to_user, seconds, created_at, expires_at, ledger_id, status) VALUES (?, ?, ?, ?, 1, 9, ?, ?)');
  tr.run('ABC234', 'nico', 'pipe', 3600, sent, 'entregado');
  tr.run('XYZ789', 'nico', null, 600, pending, 'pendiente');
  raw.close();

  const store = openStore({ dir, minWage: WAGE });
  const nico = store.state(store.auth(tok('nico')).id);
  const pipe = store.state(store.auth(tok('pipe')).id);
  assert.deepEqual(nico.ledger.map((t) => [t.note, t.seconds]), [['Código XYZ789', -600], ['Para alguien', -3600]]);
  assert.deepEqual(pipe.ledger.map((t) => [t.note, t.seconds]), [['De Nico', 3600]]);
  assert.equal(nico.expiresAt, 5_000_000);
  assert.equal(pipe.expiresAt, 6_000_000);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('el reloj parte en años, meses, semanas y días', () => {
  assert.deepEqual(split(7 * DAY), { y: 0, mo: 0, w: 1, d: 0, h: 0, m: 0, s: 0 });
  assert.deepEqual(split(7 * DAY - 1000), { y: 0, mo: 0, w: 0, d: 6, h: 23, m: 59, s: 59 });
  assert.deepEqual(split(365 * DAY + 40 * DAY + 5000), { y: 1, mo: 1, w: 1, d: 2, h: 14, m: 0, s: 5 });
  assert.deepEqual(split(-5000), { y: 0, mo: 0, w: 0, d: 0, h: 0, m: 0, s: 0 });
});
