import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.js';
import { TRIAL } from '../server/store-social.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const WAGE = 3_000_000; // 1 día de vida = $100.000
let photos = 0;
const photo = () => ({ media_type: 'image/jpeg', data: 'B'.repeat(150) + String(++photos).padStart(60, 'A') });
const item = (category, amount, proof = false, activity = category) => ({ activity, category, amount, verdict: 'aprobado', reason: '', proof });

function setup() {
  let t = Date.UTC(2026, 10, 12, 12);
  const store = openStore({ initialSeconds: 7 * 86_400, minWage: WAGE, now: () => t });
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
  assert.deepEqual(p.why, { activities: 3 * 3600, money: 11 * 86_400, received: 0, bought: 0, spent: 0, sent: 0, sentenced: 0 });
  assert.deepEqual(p.doing.map((d) => [d.category, d.amount, d.n]), [['ingreso', 1_100_000, 2], ['salud', 1, 1]]);
  assert.deepEqual(p.recent.map((r) => [r.note, r.status]), [['Venta grande', 'verificado'], ['Gimnasio', 'verificado'], ['Freelance', 'declarado']]);
  assert.equal(p.league, 'plata'); // 7 + 11 días + 3 h: más de 2 semanas
  assert.equal(p.canAccuse, false);
  assert.equal(p.accuseProblem, 'too_new'); // relojes recién creados no acusan
  assert.equal(store.profile(ana, pub(ana)).you, true);
  assert.throws(() => store.profile(ana, 'noexiste'), { code: 'target' });
});

/* ───────── juicios ───────── */

test('juicio: abre con 3 acusadores de teléfonos distintos; varias cuentas de un celular cuentan como una', () => {
  const { store, user, pub, advance } = setup();
  const target = user('Tito');
  const a1 = user('A1', { device: 'mismo-telefono-1' });
  const a2 = user('A2', { device: 'mismo-telefono-1' });
  const b = user('B');
  const c = user('C');
  const e = user('E');
  const fresh = () => user('Nuevo');
  const outsider = user('Fuera', { ranked: false });
  advance(TRIAL.minAgeMs + 1000);

  assert.throws(() => store.accuse(fresh(), { target: pub(target), reason: 'ingresos' }), { code: 'too_new' });
  assert.throws(() => store.accuse(outsider, { target: pub(target), reason: 'ingresos' }), { code: 'not_ranked' });
  assert.throws(() => store.accuse(a1, { target: pub(target), reason: 'magia' }), { code: 'reason' });
  assert.throws(() => store.accuse(a1, { target: pub(target), reason: 'otro' }), { code: 'text' }); // "otro" pide explicar
  assert.throws(() => store.accuse(target, { target: pub(target), reason: 'ingresos' }), { code: 'own' });

  assert.deepEqual(store.accuse(a1, { target: pub(target), reason: 'ingresos', text: 'De la nada 50 días' }), { opened: false, count: 1, needed: 3 });
  assert.throws(() => store.accuse(a1, { target: pub(target), reason: 'ingresos' }), { code: 'already' });
  assert.equal(store.accuse(a2, { target: pub(target), reason: 'imposible' }).count, 1); // mismo teléfono que A1
  assert.equal(store.accuse(b, { target: pub(target), reason: 'imposible' }).count, 2);
  const r = store.accuse(c, { target: pub(target), reason: 'cuentas' });
  assert.equal(r.opened, true);
  assert.equal(r.notify.userId, target);
  assert.equal(store.state(target).trial.phase, 'defensa');
  assert.throws(() => store.accuse(e, { target: pub(target), reason: 'ingresos' }), { code: 'on_trial' });

  // nadie vota: sin quórum queda libre, y nadie puede volver a juzgarlo en 14 días
  advance(TRIAL.defenseMs + TRIAL.voteMs + 1000);
  const [closed] = store.closeTrials();
  assert.deepEqual([closed.userId, closed.verdict], [target, 'sin_quorum']);
  assert.equal(store.state(target).trial, null);
  assert.equal(store.state(target).ranked, true);
  const d = user('D');
  advance(TRIAL.minAgeMs);
  assert.throws(() => store.accuse(d, { target: pub(target), reason: 'ingresos' }), { code: 'immune' });
});

test('juicio: al sospechosamente rico basta una acusación; defensa, jurado y condena', () => {
  const { store, user, pub, advance, earnWithProof } = setup();
  const rico = user('Rico', { device: 'telefono-rico', ip: '200.1.1.1' });
  const acusador = user('Acusador');
  const j1 = user('J1');
  const j2 = user('J2');
  const j3 = user('J3');
  const primo = user('Primo', { device: 'telefono-rico' }); // mismo teléfono que el acusado
  const amigo = user('Amigo');
  advance(TRIAL.minAgeMs + 1000);
  store.claimTransfer(amigo, store.createTransfer(rico, 3600).transfer.code); // se pasaron tiempo

  earnWithProof(rico, 2_000_000); // +20 días con comprobante: verificado
  store.addTx(rico, { category: 'ingreso', amount: 500_000, note: 'Bono' }); // +5 días en su palabra (sin prueba)
  assert.equal(store.state(rico).money.verified, true);
  assert.equal(store.ranking(j1, 'semana').rows[0].name, 'Rico');

  const r = store.accuse(acusador, { target: pub(rico), reason: 'ingresos', text: '25 días en una semana' });
  assert.deepEqual([r.opened, r.needed], [true, 1]); // ganó más de 2 semanas en 7 días
  const trialId = r.trialId;
  assert.equal(store.ranking(j1, 'semana').rows[0].onTrial, true);

  assert.throws(() => store.vote(j1, trialId, 'culpable'), { code: 'phase' }); // primero la defensa
  assert.equal(store.state(j1).jury, 0);
  store.defend(rico, trialId, 'Vendí mi moto, aquí está el comprobante.');
  assert.throws(() => store.defend(rico, trialId, 'otra'), { code: 'phase' }); // una sola vez
  assert.equal(store.state(j1).jury, 1); // ya puede votar
  assert.equal(store.state(rico).trial.phase, 'votacion');

  const view = store.trial(j1, trialId);
  assert.equal(view.defense, 'Vendí mi moto, aquí está el comprobante.');
  assert.deepEqual(view.accusations.map((a) => [a.reason, a.text]), [['ingresos', '25 días en una semana']]);
  assert.equal('accuser' in view.accusations[0], false); // las acusaciones son anónimas
  assert.equal(view.profile.name, 'Rico');

  assert.throws(() => store.vote(rico, trialId, 'inocente'), { code: 'own' });
  assert.throws(() => store.vote(acusador, trialId, 'culpable'), { code: 'accuser' });
  assert.throws(() => store.vote(primo, trialId, 'inocente'), { code: 'related' });
  assert.throws(() => store.vote(amigo, trialId, 'inocente'), { code: 'related' });
  assert.throws(() => store.vote(j1, trialId, 'tal vez'), { code: 'vote' });
  store.vote(j1, trialId, 'culpable');
  store.vote(j2, trialId, 'culpable');
  store.vote(j3, trialId, 'inocente');
  assert.throws(() => store.vote(j1, trialId, 'inocente'), { code: 'voted' });
  assert.equal(store.trials(j2).open[0].guilty, null); // los votos se ven al final

  const before = left(store, rico);
  advance(TRIAL.voteMs + 1000);
  const [v] = store.closeTrials();
  assert.deepEqual([v.verdict, v.penalty], ['culpable', 5 * 86_400]); // pierde lo que ganó sin prueba
  assert.equal(left(store, rico), before - TRIAL.voteMs - 1000 - 5 * DAY);
  const s = store.state(rico);
  assert.deepEqual([s.ranked, s.money.verified, s.ledger[0].category, s.ledger[0].note], [false, false, 'juicio', `Juicio #${trialId}`]);
  assert.throws(() => store.setRanked(rico, true), { code: 'banned' });
  const closed = store.trials(j1).closed[0];
  assert.deepEqual([closed.verdict, closed.guilty, closed.innocent], ['culpable', 2, 1]);
  assert.equal(store.closeTrials().length, 0);
  advance(TRIAL.banMs);
  assert.equal(store.setRanked(rico, true).state.ranked, true);
});

test('juicio: una condena nunca deja a nadie en cero (siempre le queda 1 h)', () => {
  const { store, user, pub, advance } = setup();
  const t = user('T');
  const accusers = [user('A'), user('B'), user('C')];
  const jury = [user('J1'), user('J2'), user('J3')];
  advance(TRIAL.minAgeMs + 1000);
  store.addTx(t, { category: 'ingreso', amount: 700_000, note: 'En su palabra' }); // +7 días sin prueba
  for (const a of accusers) store.accuse(a, { target: pub(t), reason: 'ingresos' });
  store.addTx(t, { category: 'consumo', amount: 300_000, note: 'Se lo gastó' }); // −3 días
  const trialId = store.state(t).trial.id;
  advance(TRIAL.defenseMs + 1000); // no se defendió: pasa a votación
  for (const j of jury) store.vote(j, trialId, 'culpable');
  advance(TRIAL.voteMs);
  const [v] = store.closeTrials();
  assert.equal(v.verdict, 'culpable');
  assert.ok(v.penalty < 7 * 86_400); // no alcanzó a quitarle los 7 días en duda
  assert.equal(left(store, t), HOUR);
});
