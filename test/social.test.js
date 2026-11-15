import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, cleanBio } from '../server/store.js';
import { buildContent, moderationContent } from '../server/judge.js';
import { powerOf } from '../public/economy.js';
import { TRIAL } from '../server/store-social.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const WAGE = 3_000_000; // 1 día de vida = $100.000
let photos = 0;
const photo = () => ({ media_type: 'image/jpeg', data: 'B'.repeat(150) + String(++photos).padStart(60, 'A') });
const item = (category, amount, proof = false, activity = category) => ({ activity, category, amount, verdict: 'aprobado', reason: '', proof });

function setup({ initial = 7 } = {}) {
  let t = Date.UTC(2026, 10, 12, 12);
  const store = openStore({ initialSeconds: initial * 86_400, minWage: WAGE, now: () => t });
  let n = 0;
  /** Cada persona en su propio teléfono y su propia red (si no, son "relacionados"). */
  const user = (nickname, { ranked = true, device, ip } = {}) => {
    n++;
    const id = store.auth(store.createUser({ nickname, deviceId: device || `dev-${n}-xxxxxx`, ip: ip || `181.50.10.${n}` }).token).id;
    if (ranked) store.setRanked(id, true);
    return id;
  };
  /** Un ingreso grande contado al Guardián con el comprobante del pago. */
  const earnWithProof = (id, amount) => {
    const day = store.openDay(id, { text: 'venta grande', images: [photo()] }).id;
    store.saveVerdict(day, { message: 'Visto el comprobante.', items: [item('ingreso', amount, true, 'Venta grande')] });
    return store.acceptDay(id, day);
  };
  const pub = (id) => store.state(id).publicId;
  return { store, user, earnWithProof, pub, now: () => t, advance: (ms) => (t += ms) };
}
const left = (store, id) => store.state(id).expiresAt - store.state(id).now;

/* ───────── ranking ───────── */

test('ranking: se entra por elección y con nombre; la semana no cuenta transferencias ni compras', () => {
  const { store, user, pub } = setup();
  const anon = user('', { ranked: false });
  assert.throws(() => store.setRanked(anon, true), { code: 'needs_name' });
  const ana = user('Ana');
  const beto = user('Beto');
  const caro = user('Caro', { ranked: false });
  assert.match(pub(ana), /^[\w-]{8}$/);
  assert.equal(store.state(caro).publicId, ''); // quien no entra no tiene identificador público

  store.addTx(ana, { category: 'ingreso', amount: 300_000, note: 'Venta de kits' }); // +3 días
  store.addTx(ana, { category: 'consumo', amount: 50_000, note: 'Antojo' }); // −12 h
  store.claimTransfer(beto, store.createTransfer(caro, 2 * 86_400).transfer.code); // Beto recibe 2 días
  store.fulfill({ ref: 'cs_1', userId: beto, product: 'dia' }); // y compra 1

  const week = store.ranking(ana, 'semana');
  assert.deepEqual(week.rows.map((r) => [r.name, r.score / 3600]), [['Ana', 60], ['Beto', 0]]);
  assert.equal(week.rows[0].you, true);
  assert.equal(week.rows.some((r) => r.name === 'Caro'), false);

  const time = store.ranking(beto, 'tiempo');
  assert.deepEqual(time.rows.map((r) => [r.name, r.score / 86_400]), [['Ana', 9.5], ['Beto', 9]]); // a Beto no le cuenta lo comprado
  assert.equal(time.me.name, 'Beto');
  assert.equal(time.rows[0].league, 'bronce');
  assert.throws(() => store.ranking(ana, 'trampa'), { code: 'board' });

  store.setNickname(beto, ''); // sin nombre no se aparece
  assert.equal(store.state(beto).ranked, false);
  assert.equal(store.ranking(ana, 'tiempo').rows.length, 1);
  store.setRanked(ana, false);
  assert.equal(store.ranking(ana, 'tiempo').rows.length, 0);
});

test('perfil: qué hace cada quien y de dónde sale su tiempo', () => {
  const { store, user, pub, earnWithProof } = setup();
  const ana = user('Ana');
  const beto = user('Beto');
  store.addTx(ana, { category: 'ingreso', amount: 200_000, note: 'Freelance' });
  const day = store.openDay(ana, { text: 'gym 1 h', images: [photo()] }).id;
  store.saveVerdict(day, { message: 'Bien.', items: [item('salud', 1, true, 'Gimnasio')] });
  store.acceptDay(ana, day);
  earnWithProof(ana, 900_000); // 9 días con comprobante: ya le cree sus ingresos

  const p = store.profile(beto, pub(ana));
  assert.equal(p.name, 'Ana');
  assert.equal(p.verified, true);
  assert.deepEqual(p.why, { activities: 3 * 3600, money: 11 * 86_400, received: 0, bought: 0, jury: 0, spent: 0, sent: 0, sentenced: 0 });
  assert.deepEqual(p.doing.map((d) => [d.category, d.amount, d.n]), [['ingreso', 1_100_000, 2], ['salud', 1, 1]]);
  assert.deepEqual(p.recent.map((r) => [r.note, r.status]), [['Venta grande', 'verificado'], ['Gimnasio', 'verificado'], ['Freelance', 'declarado']]);
  assert.equal(p.league, 'plata'); // 7 + 11 días + 3 h: más de 2 semanas
  assert.equal(p.canAccuse, false);
  assert.equal(p.accuseProblem, 'too_new'); // relojes recién creados no acusan
  assert.equal(store.profile(ana, pub(ana)).you, true);
  assert.throws(() => store.profile(ana, 'noexiste'), { code: 'target' });
});

/* ───────── juicios: día 1 (citación y defensa) y día 2 (veredicto secreto) ───────── */

const LIVED_15 = 15 * DAY + 1000; // lo que hay que vivir para poder citar a juicio
const proofs = () => [photo()];
const REVIEW = { summary: 'Transferencia de $1.500.000 del 13 de noviembre por la venta de un carro.', supports: 'si' };
const ledgerOf = (store, id) => store.state(id).ledger;
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('no lanzó error');
};

test('potestad: se gana viviendo de verdad (sin los ratos en cero), no ganando tiempo', () => {
  const { store, user, advance } = setup(); // nacen con 7 días
  const id = user('Lu', { ranked: false });
  advance(7 * DAY + 10 * DAY); // vivió 7 días y pasó 10 en cero
  assert.equal(store.state(id).lived, 7 * 86_400);
  store.rebirth(id);
  advance(2 * DAY);
  assert.equal(store.state(id).lived, 9 * 86_400); // las dos vidas, sin el tiempo muerto
  assert.deepEqual([powerOf(14 * 86_400), powerOf(15 * 86_400), powerOf(30 * 86_400), powerOf(89 * 86_400), powerOf(90 * 86_400)], [0, 1, 2, 2, 3]);
});

test('día 1: la citación es pública con lo que está en juego; varias cuentas de un celular cuentan como una; un voto al día', () => {
  const { store, user, pub, advance } = setup({ initial: 120 });
  const target = user('Tito');
  const limpio = user('Limpio');
  const otro = user('Otro');
  const a1 = user('A1', { device: 'mismo-telefono-1' });
  const a2 = user('A2', { device: 'mismo-telefono-1' });
  const b = user('B');
  const c = user('C');
  const outsider = user('Fuera', { ranked: false });
  advance(LIVED_15);
  store.addTx(target, { category: 'ingreso', amount: 300_000, note: 'En su palabra' }); // +3 días sin prueba
  store.addTx(otro, { category: 'ingreso', amount: 100_000, note: 'Otro ingreso' });

  const fresh = user('Nuevo'); // 0 días vividos
  assert.match(errorOf(() => store.accuse(fresh, { target: pub(target), reason: 'ingresos' })).text('es'), /15 días vividos de verdad \(llevas 0\)/);
  assert.throws(() => store.accuse(outsider, { target: pub(target), reason: 'ingresos' }), { code: 'not_ranked' });
  assert.throws(() => store.accuse(a1, { target: pub(target), reason: 'magia' }), { code: 'reason' });
  assert.throws(() => store.accuse(a1, { target: pub(target), reason: 'otro' }), { code: 'text' }); // "otro" pide explicar
  assert.throws(() => store.accuseCheck(target, { target: pub(target), reason: 'ingresos' }), { code: 'own' });
  assert.throws(() => store.accuse(a1, { target: pub(limpio), reason: 'ingresos' }), { code: 'nothing' }); // nada en juego

  const r = store.accuse(a1, { target: pub(target), reason: 'ingresos', text: 'De la nada 3 días' });
  assert.deepEqual([r.opened, r.people, r.count, r.needed, r.weight, r.stake], [true, 1, 1, 3, 1, 3 * 86_400]);
  assert.equal(r.notify.userId, target);
  assert.throws(() => store.accuse(a1, { target: pub(otro), reason: 'ingresos' }), { code: 'vote_limit' }); // un voto al día
  assert.equal(store.accuse(a2, { target: pub(target), reason: 'imposible' }).count, 1); // mismo teléfono que A1
  assert.equal(store.accuse(b, { target: pub(target), reason: 'imposible' }).count, 2);
  const card = store.trials(outsider).open[0];
  assert.deepEqual([card.phase, card.stake, card.summons.people, card.summons.points, card.voters], ['citacion', 3 * 86_400, 3, 2, 0]);
  assert.equal(store.profile(outsider, pub(target)).trial.points, 2); // cualquiera ve cuántos lo quieren a juicio
  advance(DAY / 2);
  assert.throws(() => store.accuse(b, { target: pub(target), reason: 'imposible' }), { code: 'already' });
  assert.equal(store.accuse(c, { target: pub(target), reason: 'cuentas' }).count, 3);
  assert.equal(store.state(target).trial.phase, 'citacion');

  // la defensa: solo el día 1, una vez y con pruebas
  assert.throws(() => store.defenseCheck(target, r.trialId, { text: 'Soy inocente' }), { code: 'proofs' });
  assert.throws(() => store.defenseCheck(target, r.trialId, { text: 'Soy inocente', images: [photo(), photo(), photo(), photo()] }), { code: 'proofs' });
  assert.throws(() => store.defenseCheck(target, r.trialId, { text: '', images: proofs() }), { code: 'text' });
  assert.throws(() => store.defenseCheck(b, r.trialId, { text: 'x', images: proofs() }), { code: 'not_found' }); // solo el citado
  const ctx = store.defenseCheck(target, r.trialId, { text: 'Mira', images: proofs() }).context;
  assert.deepEqual(ctx.accusations.map((a) => a.reason), ['ingresos', 'imposible', 'imposible', 'cuentas']);
  assert.deepEqual(ctx.gains.map((g) => g.note), ['En su palabra']);
  store.defend(target, r.trialId, { text: 'Fue una venta, aquí el comprobante.', images: proofs(), review: REVIEW });
  assert.throws(() => store.defend(target, r.trialId, { text: 'otra', images: proofs(), review: REVIEW }), { code: 'phase' });
  assert.equal(store.trial(outsider, r.trialId).proofs, null); // el día 1 las pruebas solo las ve el citado
  assert.equal(store.trial(outsider, r.trialId).review.supports, 'si'); // lo que leyó el Guardián, todos

  advance(DAY / 2 + 1000); // acaba el día 1
  const out = store.closeTrials();
  assert.deepEqual(out.map((o) => [o.kind, o.userId === target]).sort(), [['reconsider', false], ['reconsider', false], ['reconsider', false], ['reconsider', false], ['votacion', true]]);
  assert.equal(store.state(target).trial.phase, 'votacion');
  assert.throws(() => store.accuse(user('Tarde'), { target: pub(target), reason: 'ingresos' }), { code: 'too_new' });
});

test('día 1: sin potestad se archiva (y queda inmune); completa y sin defensa es culpable, y lo en juego va a quienes lo citaron', () => {
  const { store, user, pub, advance } = setup({ initial: 120 });
  const solo = user('Solo');
  const flojo = user('Flojo');
  const [a, b, c, d] = [user('A'), user('B'), user('C'), user('D')];
  advance(LIVED_15);
  store.addTx(solo, { category: 'ingreso', amount: 200_000, note: 'x' });
  store.addTx(flojo, { category: 'ingreso', amount: 600_000, note: 'En su palabra' }); // 6 días en juego
  store.accuse(a, { target: pub(solo), reason: 'ingresos' }); // nadie más se suma
  for (const x of [b, c, d]) store.accuse(x, { target: pub(flojo), reason: 'ingresos' });
  const before = { flojo: left(store, flojo), b: left(store, b) };
  advance(DAY + 1000);
  const out = store.closeTrials();
  assert.ok(out.some((o) => o.userId === solo && o.kind === 'archivado'));
  assert.ok(out.some((o) => o.userId === flojo && o.kind === 'culpable' && o.amount === 6 * 86_400));
  assert.equal(out.filter((o) => o.kind === 'reward').length, 3);
  assert.equal(left(store, flojo), before.flojo - DAY - 1000 - 6 * DAY);
  assert.equal(left(store, b), before.b - DAY - 1000 + 2 * DAY); // 6 días / 3 que lo citaron
  assert.deepEqual([ledgerOf(store, b)[0].category, ledgerOf(store, b)[0].seconds], ['jurado', 2 * 86_400]);
  assert.deepEqual([store.state(flojo).ranked, store.state(flojo).bannedUntil > 0], [false, true]);
  assert.equal(store.trials(a).closed.find((t) => t.name === 'Flojo').defended, false);
  assert.throws(() => store.accuse(user('E', { device: 'e' }), { target: pub(solo), reason: 'ingresos' }), { code: 'too_new' });
  advance(DAY);
  assert.throws(() => store.accuse(a, { target: pub(solo), reason: 'ingresos' }), { code: 'immune' }); // archivado: 14 días libre
});

test('día 2: votos secretos (solo se ve cuántos votaron); culpable reparte lo en juego entre quienes votaron culpable', () => {
  const { store, user, pub, advance, earnWithProof } = setup({ initial: 120 });
  const rico = user('Rico', { device: 'telefono-rico', ip: '200.1.1.1' });
  const acusador = user('Acusador');
  const [j1, j2, j3, j4] = [user('J1'), user('J2'), user('J3'), user('J4')];
  const primo = user('Primo', { device: 'telefono-rico' }); // mismo teléfono que el acusado
  const amigo = user('Amigo');
  advance(LIVED_15);
  store.claimTransfer(amigo, store.createTransfer(rico, 3600).transfer.code); // se pasaron tiempo
  earnWithProof(rico, 2_000_000); // +20 días con comprobante: no está en juego
  store.addTx(rico, { category: 'ingreso', amount: 500_000, note: 'Bono' }); // +5 días en su palabra: en juego
  store.addTx(j4, { category: 'ingreso', amount: 100_000, note: 'Algo' });
  assert.equal(store.ranking(j1, 'semana').rows[0].name, 'Rico');

  const r = store.accuse(acusador, { target: pub(rico), reason: 'ingresos', text: '25 días en una semana' });
  assert.deepEqual([r.opened, r.needed, r.stake], [true, 1, 5 * 86_400]); // ganó más de 2 semanas en 7 días: basta 1
  assert.throws(() => store.vote(j1, r.trialId, 'culpable'), { code: 'phase' }); // el día 1 no se vota el veredicto
  store.defend(rico, r.trialId, { text: 'Vendí mi moto, aquí está el comprobante.', images: proofs(), review: REVIEW });
  advance(DAY + 1000);
  store.closeTrials();
  assert.equal(store.state(j1).jury, 1);

  assert.equal(store.trial(j4, r.trialId).proofs.length, 1); // el jurado ve las pruebas
  assert.equal(store.trial(primo, r.trialId).proofs, null); // quien no puede votar, no
  assert.throws(() => store.vote(rico, r.trialId, 'inocente'), { code: 'own' });
  assert.throws(() => store.vote(primo, r.trialId, 'inocente'), { code: 'related' });
  assert.throws(() => store.vote(amigo, r.trialId, 'inocente'), { code: 'related' });
  assert.throws(() => store.vote(j1, r.trialId, 'tal vez'), { code: 'vote' });
  store.vote(acusador, r.trialId, 'culpable'); // quien lo citó reconsidera con las pruebas
  store.vote(j1, r.trialId, 'culpable');
  store.vote(j2, r.trialId, 'culpable');
  store.vote(j3, r.trialId, 'inocente');
  assert.throws(() => store.vote(j1, r.trialId, 'inocente'), { code: 'voted' });
  const secret = store.trial(j2, r.trialId);
  assert.deepEqual([secret.voters, secret.voted, secret.guilty, secret.innocent, 'myVote' in secret], [4, true, null, null, false]);
  assert.throws(() => store.accuse(j1, { target: pub(j4), reason: 'otro', text: 'x' }), { code: 'vote_limit' }); // ya votó hoy

  const before = { rico: left(store, rico), j1: left(store, j1), j3: left(store, j3) };
  advance(DAY);
  const out = store.closeTrials();
  const verdict = out.find((o) => o.userId === rico);
  assert.deepEqual([verdict.kind, verdict.amount], ['culpable', 5 * 86_400]);
  assert.equal(left(store, rico), before.rico - DAY - 5 * DAY);
  const share = Math.floor((5 * 86_400) / 3);
  assert.equal(left(store, j1), before.j1 - DAY + share * 1000); // su parte de lo que estaba en juego
  assert.equal(left(store, j3), before.j3 - DAY); // votó inocente: nada
  const closed = store.trials(j1).closed[0];
  assert.deepEqual([closed.verdict, closed.guilty, closed.innocent, closed.penalty], ['culpable', 3, 1, 5 * 86_400]); // se revelan al final
  assert.equal(store.trial(j1, r.trialId).proofCount, 0); // las fotos se borran
  const s = store.state(rico);
  assert.deepEqual([s.ranked, s.money.verified, s.ledger[0].category], [false, false, 'juicio']);
  assert.throws(() => store.setRanked(rico, true), { code: 'banned' });
  advance(TRIAL.banMs);
  assert.equal(store.setRanked(rico, true).state.ranked, true);
});

test('día 2: inocente conserva lo en disputa y gana 1 día, igual que quienes votaron inocente; sin quórum, libre', () => {
  const { store, user, pub, advance } = setup({ initial: 120 });
  const t1 = user('Uno');
  const t2 = user('Dos');
  const [a, b, c, d, e, f] = [user('A'), user('B'), user('C'), user('D'), user('E'), user('F')];
  advance(LIVED_15);
  store.addTx(t1, { category: 'ingreso', amount: 300_000, note: 'Venta' });
  store.addTx(t2, { category: 'ingreso', amount: 300_000, note: 'Venta' });
  for (const x of [a, b, c]) store.accuse(x, { target: pub(t1), reason: 'ingresos' });
  for (const x of [d, e, f]) store.accuse(x, { target: pub(t2), reason: 'ingresos' });
  const id1 = store.state(t1).trial.id;
  const id2 = store.state(t2).trial.id;
  store.defend(t1, id1, { text: 'Prueba', images: proofs(), review: REVIEW });
  store.defend(t2, id2, { text: 'Prueba', images: proofs(), review: REVIEW });
  advance(DAY + 1000);
  store.closeTrials();
  store.vote(a, id1, 'inocente');
  store.vote(b, id1, 'inocente');
  store.vote(c, id1, 'culpable');
  store.vote(d, id2, 'culpable'); // solo 2 votos: sin quórum
  store.vote(e, id2, 'culpable');
  const before = { t1: left(store, t1), t2: left(store, t2), a: left(store, a), c: left(store, c), d: left(store, d) };
  advance(DAY);
  const out = store.closeTrials();
  assert.deepEqual(out.filter((o) => o.userId === t1 || o.userId === t2).map((o) => o.kind).sort(), ['inocente', 'sin_quorum']);
  assert.equal(left(store, t1), before.t1 - DAY + DAY); // conserva todo y gana 1 día
  assert.equal(ledgerOf(store, t1)[0].note, `Absuelto #${id1}`);
  assert.equal(left(store, a), before.a - DAY + DAY); // votó inocente: 1 día
  assert.equal(left(store, c), before.c - DAY);
  assert.equal(left(store, t2), before.t2 - DAY); // sin quórum: nada cambia
  assert.equal(left(store, d), before.d - DAY);
  assert.equal(store.ranking(a, 'semana').rows.find((x) => x.name === 'A').score, 0); // los premios no cuentan en el ranking
});

test('una condena nunca deja a nadie en cero (siempre le queda 1 h)', () => {
  const { store, user, pub, advance } = setup({ initial: 120 });
  const t = user('T');
  const amiga = user('Amiga', { ranked: false });
  const accusers = [user('A'), user('B'), user('C')];
  advance(LIVED_15);
  store.addTx(t, { category: 'ingreso', amount: 700_000, note: 'En su palabra' }); // 7 días en juego
  for (const a of accusers) store.accuse(a, { target: pub(t), reason: 'ingresos' });
  const give = Math.floor(left(store, t) / 1000) - 5 * 86_400; // regala casi todo: le quedan 5 días
  store.claimTransfer(amiga, store.createTransfer(t, give).transfer.code);
  advance(DAY + 1000); // no se defendió
  const v = store.closeTrials().find((o) => o.userId === t);
  assert.equal(v.kind, 'culpable');
  assert.ok(v.amount < 7 * 86_400); // no alcanzó a quitarle los 7 días en juego
  assert.equal(left(store, t), HOUR);
});

test('el Guardián cita a juicio a quien está en el ranking (y con eso basta); la gente se puede sumar', () => {
  const { store, user, pub, advance } = setup({ initial: 120 });
  const sospechoso = user('Sospechoso');
  const anonimo = user('Anónimo', { ranked: false });
  const vecina = user('Vecina');
  advance(LIVED_15);
  const guardianSays = (id) => {
    store.addTx(id, { category: 'ingreso', amount: 500_000, note: 'Otra venta enorme' });
    const day = store.openDay(id, { text: 'hoy vendí otra vez 500 mil' }).id;
    store.saveVerdict(day, { message: 'Esto no cuadra.', summon: true, summon_reason: 'Ingresos enormes cada día sin prueba', items: [] });
    return store.acceptDay(id, day);
  };
  assert.equal(guardianSays(anonimo).summoned, false); // no está en el ranking: no se le juzga en público
  const r = guardianSays(sospechoso);
  assert.equal(r.summoned, true);
  assert.equal(r.state.trial.phase, 'citacion');
  const card = store.trial(vecina, r.state.trial.id);
  assert.deepEqual([card.byGuardian, card.needed, card.stake], ['Ingresos enormes cada día sin prueba', 0, 5 * 86_400]);
  assert.equal(store.accuse(vecina, { target: pub(sospechoso), reason: 'ingresos' }).opened, false); // se suma
  const before = left(store, vecina);
  advance(DAY + 1000); // no se defendió: culpable; lo en juego, para quien se sumó
  const out = store.closeTrials();
  assert.ok(out.some((o) => o.userId === sospechoso && o.kind === 'culpable'));
  assert.equal(left(store, vecina), before - DAY - 1000 + 5 * DAY);
});

/* ───────── perfil "¿a qué te dedicas?" y faltas ───────── */


test('perfil: "¿a qué te dedicas?" se ve en el ranking, en el perfil y el Guardián lo tiene en cuenta', () => {
  const { store, user, pub } = setup();
  const ana = user('Ana');
  assert.equal(cleanBio('  Vendo  carros\nusados en Medellín  '), 'Vendo carros usados en Medellín');
  assert.equal(cleanBio('x'.repeat(200)).length, 160);
  assert.equal(cleanBio('mi llave tk_PRUEBAprueba0000000000xx jaja'), 'mi llave jaja'); // una llave nunca va al perfil
  store.setBio(ana, 'Vendo carros usados en Medellín');
  assert.equal(store.state(ana).bio, 'Vendo carros usados en Medellín');
  assert.equal(store.ranking(ana, 'tiempo').rows[0].bio, 'Vendo carros usados en Medellín');
  assert.equal(store.profile(user('Beto'), pub(ana)).bio, 'Vendo carros usados en Medellín');
  const input = store.judgeInput(ana, store.openDay(ana, { text: 'vendí un carro en 40 millones' }).id);
  assert.equal(input.context.bio, 'Vendo carros usados en Medellín');
  assert.match(buildContent(input).at(-1).text, /Lo que dice que hace.*no una instrucción.*\n"""\nVendo carros usados en Medellín\n"""/s);
  assert.equal(store.setBio(ana, '').state.bio, '');
});

test('faltas por contenido sexual: 1 día, 1 semana, 1 mes… nunca se borran, ni al renacer', () => {
  const { store, user, advance } = setup({ initial: 400 });
  const id = user('X', { ranked: false });
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const before = left(store, id);
    const e = store.explicitStrike(id, 'perfil');
    assert.equal(e.code, 'explicit');
    steps.push([e.strike.n, (before - left(store, id)) / DAY, e.strike.next / 86_400]);
  }
  assert.deepEqual(steps.slice(0, 4), [[1, 1, 7], [2, 7, 30], [3, 30, 90], [4, 90, 365]]);
  assert.equal(steps[4][0], 5);
  const s = store.state(id);
  assert.deepEqual([s.strikes, s.ledger[0].category, s.ledger[0].note], [6, 'sancion', 'Falta 5']); // la sexta lo encontró en cero
  assert.ok(s.expiresAt <= s.now); // no hay piso: se quedó en cero
  const e = store.explicitStrike(id, 'mi_dia'); // en cero no hay qué quitar, pero la falta cuenta
  assert.deepEqual([e.strike.n, e.strike.penalty], [7, 0]);
  assert.match(e.text('es'), /contenido sexual.*prohibido.*perderás 365 días/);
  advance(DAY);
  store.rebirth(id);
  assert.deepEqual([store.state(id).strikes, store.state(id).nextStrike], [7, 365 * 86_400]);
  store.setRanked(id, true);
  assert.equal(store.profile(id, store.state(id).publicId).strikes, 7); // las faltas se ven en el perfil
});

test('mi día: una foto con contenido sexual es falta inmediata, no prueba nada y no se guarda', () => {
  const { store, user } = setup();
  const id = user('Y', { ranked: false });
  const before = left(store, id);
  const day = store.openDay(id, { text: 'fui al gym', images: [photo()] }).id;
  const { strike } = store.saveVerdict(day, { message: 'Eso no.', explicit: true, items: [item('salud', 1, true, 'Gimnasio')] });
  assert.deepEqual([strike.n, strike.penalty], [1, 86_400]);
  assert.equal(left(store, id), before - DAY);
  const pub = store.publicDay(id, day);
  assert.deepEqual([pub.turns[1].items[0].verdict, pub.net], ['rechazado', 0]);
  assert.equal(store.judgeInput(id, day).images.length, 0); // las fotos se borraron
  // sin fotos no puede haber falta, diga lo que diga la IA
  const other = store.openDay(id, { text: 'nada' }).id;
  assert.equal(store.saveVerdict(other, { message: 'ok', explicit: true, items: [] }).strike, null);
});

test('moderación: el Guardián ve de qué acusan a alguien y lo que ganó, y el texto va entre comillas', () => {
  const content = moderationContent({
    kind: 'defense',
    text: 'Vendí mi carro',
    images: [photo()],
    context: {
      accusations: [{ reason: 'ingresos', text: 'De la nada' }],
      gains: [{ note: 'Venta de un carro', category: 'ingreso', amount: 1_500_000, status: 'verificado' }, { note: 'Bono', category: 'ingreso', amount: 200_000, status: 'declarado' }],
    },
  });
  assert.equal(content.filter((b) => b.type === 'image').length, 1);
  const text = content.at(-1).text;
  assert.match(text, /su defensa en un juicio/);
  assert.match(text, /- ingresos inflados: "De la nada"/);
  assert.match(text, /Venta de un carro \(ingreso, \$\s?1\.500\.000, ya probado ante el Guardián\)/);
  assert.match(text, /Bono \(ingreso, \$\s?200\.000, sin prueba\)/);
  assert.match(text, /"""\nVendí mi carro\n"""/);
});
