import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openStore, alertBand, startOfLocalDay, MIGRATIONS } from '../server/store.js';
import { buildContent, systemFor } from '../server/judge.js';
import { alertFor, reminderFor } from '../server/push.js';
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

test('mi día: 7 charlas por fecha del calendario, se renuevan a medianoche (no 24 h después)', () => {
  const { store, id, advance } = setup(); // 07:00 en Bogotá
  assert.equal(store.state(id).daysPerDay, 7);
  assert.equal(store.state(id).daysLeft, 7);
  assert.equal(store.state(id).daysResetAt, Date.UTC(2026, 10, 13, 5)); // medianoche de Bogotá en UTC
  for (let i = 0; i < 7; i++) store.openDay(id, { text: `charla ${i + 1}` });
  assert.equal(store.state(id).daysLeft, 0);
  assert.throws(() => store.openDay(id, { text: 'la octava' }), { code: 'days', message: /7 charlas/ });
  advance(16 * HOUR + 59 * MIN); // 23:59: sigue siendo hoy
  assert.throws(() => store.openDay(id, { text: 'casi medianoche' }), { code: 'days' });
  advance(2 * MIN); // 00:01: fecha nueva, aunque no han pasado 24 h desde la primera charla
  assert.equal(store.state(id).daysLeft, 7);
  store.openDay(id, { text: 'mañana nueva' });
  assert.equal(store.state(id).daysLeft, 6);
});

test('mi día: "hoy" es la fecha en la zona del teléfono, que llega con cada charla', () => {
  const { store, id } = setup(); // 12:00 UTC = 21:00 en Tokio
  store.openDay(id, { text: 'desde Tokio', tz: 'Asia/Tokyo' });
  const s = store.state(id);
  assert.equal(s.daysLeft, 6);
  assert.equal(s.daysResetAt, Date.UTC(2026, 10, 12, 15)); // medianoche de Tokio, 3 h después
  assert.equal(s.expiresAt, store.state(id).expiresAt); // la zona no toca el reloj
});

test('inicio del día local, también el día que cambia la hora', () => {
  assert.equal(startOfLocalDay(Date.UTC(2026, 10, 12, 4, 59), ''), Date.UTC(2026, 10, 11, 5)); // 23:59 en Bogotá
  assert.equal(startOfLocalDay(Date.UTC(2026, 10, 12, 5), 'America/Bogota'), Date.UTC(2026, 10, 12, 5));
  // Nueva York pasa a horario de verano el 8 de marzo a las 2:00: la medianoche fue con el desfase de invierno (−5 h).
  assert.equal(startOfLocalDay(Date.UTC(2026, 2, 8, 18), 'America/New_York'), Date.UTC(2026, 2, 8, 5));
  assert.equal(startOfLocalDay(Date.UTC(2026, 10, 1, 18), 'America/New_York'), Date.UTC(2026, 10, 1, 4)); // y al volver
  assert.equal(startOfLocalDay(Date.UTC(2026, 5, 1, 2), 'Asia/Kolkata'), Date.UTC(2026, 4, 31, 18, 30)); // desfase de media hora
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

test('migración v9: idioma de la app, sin tocar el reloj', () => {
  const dir = tmpDir();
  const raw = new DatabaseSync(path.join(dir, 'tiempo.db'));
  for (const sql of MIGRATIONS.slice(0, 8)) raw.exec(sql); // la base como estaba en v8
  raw.exec('PRAGMA user_version = 8');
  const token = 'tk_hermana_000000000000000000';
  const expires = Date.UTC(2026, 10, 21, 3, 14, 15);
  raw
    .prepare('INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at, nickname) VALUES (?, ?, 1, 1, 1, ?, ?)')
    .run('u1', createHash('sha256').update(token).digest('base64url'), expires, 'Ana');
  raw.close();

  const store = openStore({ dir, minWage: WAGE });
  const id = store.auth(token).id;
  assert.equal(store.auth(token).lang, ''); // sin elegir: la app usa inglés
  store.setLang(id, 'es');
  store.setLang(id, 'klingon'); // se ignora
  assert.equal(store.auth(token).lang, 'es');
  assert.equal(store.state(id).expiresAt, expires);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idioma: los errores se responden en inglés o en español', () => {
  const { store, id } = setup();
  const err = (fn) => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    assert.fail('no lanzó error');
  };
  const empty = err(() => store.openDay(id, { text: '' }));
  assert.equal(empty.text('en'), 'Tell the Guardian what you did');
  assert.equal(empty.text('es'), 'Cuéntale al Guardián qué hiciste');
  assert.equal(empty.text(''), 'Cuéntale al Guardián qué hiciste'); // una app vieja no manda idioma: español
  const judged = err(() => add(store, id, 'salud', 1));
  assert.equal(judged.text('en'), 'Health is logged in "My day", with the Guardian');
  assert.equal(judged.text('es'), 'Salud se cuenta en "Mi día", con el Guardián');
});

test('idioma: avisos push, recordatorios y Guardián en el idioma de cada persona', () => {
  const { store, id, advance } = setup();
  const other = store.auth(store.createUser({ lang: 'es' }).token).id;
  assert.equal(store.auth(store.createUser({ lang: 'xx' }).token).lang, '');
  store.addSub(id, SUB);
  store.addSub(other, { ...SUB, endpoint: 'https://push.example/otro' });
  advance(6 * DAY + 1000); // los dos entran en su último día
  const alerts = Object.fromEntries(store.claimAlerts().map((a) => [a.userId, a.lang]));
  assert.deepEqual(alerts, { [id]: 'en', [other]: 'es' });
  assert.equal(alertFor(86_400, 'es').title, 'Menos de 24 horas');
  assert.equal(alertFor(86_400, 'en').title, 'Less than 24 hours');
  assert.equal(alertFor(0, '').title, "Time's up");
  assert.equal(reminderFor(9, 'es').title, '¿Cómo va tu día?');
  assert.equal(reminderFor(20, 'en').title, 'Before the day ends');

  const dayId = store.openDay(other, { text: 'fui al gym' }).id;
  assert.equal(store.judgeInput(other, dayId).lang, 'es');
  assert.equal(store.judgeInput(id, store.openDay(id, { text: 'gym' }).id).lang, 'en');
  assert.match(systemFor('es'), /en español latino/);
  assert.match(systemFor('en'), /en inglés \(English\)/);
  assert.match(systemFor(undefined), /en inglés \(English\)/);
});

/* ───────── dinero: límites y confianza ───────── */

test('dinero en tu palabra: hasta 7 días de vida por semana; para más, el Guardián con prueba', () => {
  const { store, id, advance } = setup();
  add(store, id, 'ingreso', 500_000); // 5 días
  add(store, id, 'inversion', 400_000); // 2 días (la inversión vale la mitad)
  assert.deepEqual(store.state(id).money, { used: 7 * 86_400, word: 7 * 86_400, cap: 30 * 86_400, verified: false, windowDays: 7 });
  const e = (() => {
    try {
      add(store, id, 'ingreso', 1_000);
    } catch (err) {
      return err;
    }
  })();
  assert.equal(e.code, 'money_word');
  assert.match(e.text('es'), /Guardián.*prueba del pago/);
  assert.match(e.text('en'), /proof of payment/);
  add(store, id, 'consumo', 100_000); // los gastos no tienen tope
  advance(7 * DAY + 1000); // la ventana es de 7 días
  assert.equal(store.state(id).money.used, 0);
  add(store, id, 'ingreso', 100_000);
});

test('el Guardián: sin prueba solo lo que entra en tu palabra; con prueba hasta el tope; un ingreso grande probado da confianza', () => {
  const { store, id } = setup();
  add(store, id, 'ingreso', 600_000); // 6 de 7 días en su palabra
  const a = store.openDay(id, { text: 'me gané 3 millones' }).id;
  store.saveVerdict(a, verdict({ ...item('ingreso', 3_000_000), proof: true })); // dice que hay prueba, pero no hay fotos
  const capped = store.publicDay(id, a).turns[1].items[0];
  assert.deepEqual([capped.proof, capped.amount, capped.capped, capped.limit], [false, 100_000, true, 'proof']); // solo el día que le cabe
  store.discardDay(id, a);

  const b = store.openDay(id, { text: 'aquí el comprobante', images: [PHOTO] }).id;
  store.saveVerdict(b, verdict({ ...item('ingreso', 3_000_000), proof: true }));
  const proved = store.publicDay(id, b).turns[1].items[0];
  assert.deepEqual([proved.proof, proved.amount, proved.limit], [true, 2_400_000, 'cap']); // hasta 30 días por semana, para todos
  const r = store.acceptDay(id, b);
  assert.equal(r.trusted, true);
  assert.equal(r.state.ledger[0].status, 'verificado');
  assert.deepEqual([r.state.money.verified, r.state.money.word], [true, 30 * 86_400]); // ya le cree hasta el tope
  assert.throws(() => add(store, id, 'ingreso', 1_000), { code: 'money_cap' }); // pero el tope es el tope
});

test('un día humano: estudio + ejercicio + proyecto no pasan de 16 h en 24 h', () => {
  const { store, id, advance } = setup();
  const a = store.openDay(id, { text: 'estudié 8 h, proyecto 10 h y gym 2 h', images: [PHOTO] }).id;
  store.saveVerdict(a, verdict(item('aprendizaje', 8), item('proyecto', 10), item('salud', 2)));
  const items = store.publicDay(id, a).turns[1].items;
  assert.deepEqual(items.map((x) => [x.amount, x.capped]), [[8, false], [8, true], [0, true]]);
  store.acceptDay(id, a);
  const b = store.openDay(id, { text: 'y 1 h más de estudio' }).id;
  store.saveVerdict(b, verdict(item('aprendizaje', 1)));
  assert.equal(store.publicDay(id, b).net, 0); // ya no le caben horas hoy
  advance(DAY + 1000);
  const c = store.openDay(id, { text: 'mañana: 1 h de estudio' }).id;
  store.saveVerdict(c, verdict(item('aprendizaje', 1)));
  assert.equal(store.publicDay(id, c).net, 2 * 3600);
});

test('el Guardián recibe lo que ya contaste, tu límite de dinero y si tus ingresos están verificados', () => {
  const { store, id } = setup();
  add(store, id, 'ingreso', 250_000, 'Venta');
  const a = store.openDay(id, { text: 'gym', images: [PHOTO] }).id;
  store.saveVerdict(a, verdict(item('salud', 1.5), item('proyecto', 3)));
  store.acceptDay(id, a);
  const input = store.judgeInput(id, store.openDay(id, { text: 'corrí 100 km y aprendí 10 cálculos' }).id);
  assert.deepEqual(input.context.hours, { aprendizaje: 0, salud: 1.5, proyecto: 3 });
  assert.equal(input.context.wordLeft, 450_000); // 4,5 días de $100.000
  assert.equal(input.context.capLeft, 2_750_000);
  assert.deepEqual([input.context.verified, input.context.income30, input.context.incomeMax30], [false, 250_000, 250_000]);
  assert.equal(input.maxReplies, 2);

  const text = buildContent(input).at(-1).text;
  assert.match(text, /Datos del servidor sobre esta persona/);
  assert.match(text, /salud 1\.5 h \(máximo 2\).*En total 4\.5 h de 16/s);
  assert.match(text, /en su palabra aún le caben \$\s?450\.000/);
  assert.match(text, /verificados por el Guardián: no/);
  assert.ok(text.indexOf('Datos del servidor') < text.indexOf('"""'), 'los datos del servidor van antes de lo que cuenta la persona');
  const sys = systemFor('en', { usdCop: 4100 });
  assert.match(sys, /1 USD = 4\.100 COP/);
  assert.match(sys, /humanamente posible/);
  assert.match(sys, /aprendí 10 cálculos/);
  assert.match(sys, /necesita_prueba.*captura del pago/s);
});

test('migración v10: pagos, ranking y juicios llegan sin tocar ningún reloj', () => {
  const dir = tmpDir();
  const raw = new DatabaseSync(path.join(dir, 'tiempo.db'));
  for (const sql of MIGRATIONS.slice(0, 9)) raw.exec(sql); // la base como estaba en v9
  raw.exec('PRAGMA user_version = 9');
  const token = 'tk_prima_00000000000000000000';
  const expires = Date.UTC(2026, 10, 25, 8, 9, 10);
  raw
    .prepare('INSERT INTO users (id, token_hash, created_at, life_no, born_at, expires_at, nickname, lang) VALUES (?, ?, 1, 2, 1, ?, ?, ?)')
    .run('u1', createHash('sha256').update(token).digest('base64url'), expires, 'Lu', 'es');
  raw.prepare(`INSERT INTO ledger (user_id, life_no, at, seconds, note, category, amount, status) VALUES ('u1', 2, 5, 3600, 'Venta', 'ingreso', 4000, 'declarado')`).run();
  raw.close();

  const store = openStore({ dir, minWage: WAGE });
  const s = store.state(store.auth(token).id);
  assert.equal(s.expiresAt, expires);
  assert.equal(s.lifeNo, 2);
  assert.deepEqual(s.ledger.map((t) => [t.note, t.seconds]), [['Venta', 3600]]);
  assert.deepEqual([s.ranked, s.publicId, s.plus.active, s.money.verified, s.trial, s.jury], [false, '', false, false, null, 0]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('el reloj parte en años, meses, semanas y días', () => {
  assert.deepEqual(split(7 * DAY), { y: 0, mo: 0, w: 1, d: 0, h: 0, m: 0, s: 0 });
  assert.deepEqual(split(7 * DAY - 1000), { y: 0, mo: 0, w: 0, d: 6, h: 23, m: 59, s: 59 });
  assert.deepEqual(split(365 * DAY + 40 * DAY + 5000), { y: 1, mo: 1, w: 1, d: 2, h: 14, m: 0, s: 5 });
  assert.deepEqual(split(-5000), { y: 0, mo: 0, w: 0, d: 0, h: 0, m: 0, s: 0 });
});
