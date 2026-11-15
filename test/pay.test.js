import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openStore } from '../server/store.js';
import { createPayments, verifySignature, eventAction, PRODUCTS } from '../server/payments.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const WAGE = 3_000_000; // 1 día de vida = $100.000

function setup() {
  let t = Date.UTC(2026, 10, 12, 12);
  const store = openStore({ initialSeconds: 7 * 86_400, minWage: WAGE, now: () => t });
  const user = (nickname) => store.auth(store.createUser({ nickname }).token).id;
  return { store, user, now: () => t, advance: (ms) => (t += ms) };
}
const left = (store, id) => store.state(id).expiresAt - store.state(id).now;
let refs = 0;
const paid = (userId, product, extra = {}) => ({ ref: `cs_test_${++refs}`, userId, product, paymentRef: `pi_${refs}`, amount: PRODUCTS[product].price, currency: 'usd', ...extra });

/* ───────── webhook de Stripe ───────── */

const SECRET = 'whsec_prueba_000';
const sign = (raw, t, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

test('webhook: solo pasa con la firma de Stripe, reciente y del cuerpo exacto', () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
  const t = Math.floor(Date.now() / 1000);
  assert.doesNotThrow(() => verifySignature(Buffer.from(raw), sign(raw, t), SECRET, t));
  assert.doesNotThrow(() => verifySignature(Buffer.from(raw), `t=${t},v1=00ff,${sign(raw, t).split(',')[1]}`, SECRET, t)); // varias firmas
  const bad = { code: 'signature', status: 400 };
  assert.throws(() => verifySignature(Buffer.from(raw + ' '), sign(raw, t), SECRET, t), bad); // cuerpo alterado
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw, t, 'whsec_otro'), SECRET, t), bad); // otro secreto
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw, t - 600), SECRET, t), bad); // de hace 10 min
  assert.throws(() => verifySignature(Buffer.from(raw), '', SECRET, t), bad);
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw, t), '', t), bad);

  const pay = createPayments({ secretKey: 'sk_test_x', webhookSecret: SECRET });
  assert.equal(pay.webhookReady, true);
  assert.equal(pay.testMode, true);
  const now = Math.floor(Date.now() / 1000);
  const ev = pay.parseWebhook(Buffer.from(raw), sign(raw, now));
  assert.equal(ev.type, 'checkout.session.completed');
});

test('webhook: traduce cada evento de Stripe a una acción de la app (facturas viejas y nuevas)', () => {
  const session = { id: 'cs_1', client_reference_id: 'u1', metadata: { product: 'dia', user_id: 'u1' }, payment_status: 'paid', payment_intent: 'pi_1', amount_total: 99, currency: 'usd' };
  assert.deepEqual(eventAction({ type: 'checkout.session.completed', data: { object: session } }), {
    type: 'paid', ref: 'cs_1', userId: 'u1', product: 'dia', paid: true, paymentRef: 'pi_1', subscription: '', amount: 99, currency: 'usd',
  });
  assert.equal(eventAction({ type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'unpaid' } } }).type, 'pending');
  assert.equal(eventAction({ type: 'checkout.session.async_payment_succeeded', data: { object: session } }).type, 'paid');

  const lines = { data: [{ period: { end: 1_800_000_000 } }, { period: { end: 1_800_000_100 } }] };
  const nueva = { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1', metadata: { user_id: 'u1' } } }, lines, amount_paid: 299, currency: 'usd', billing_reason: 'subscription_cycle' };
  const vieja = { id: 'in_2', subscription: 'sub_1', subscription_details: { metadata: { user_id: 'u1' } }, lines, amount_paid: 299, currency: 'usd', billing_reason: 'subscription_create' };
  for (const [inv, first] of [[nueva, false], [vieja, true]]) {
    const a = eventAction({ type: 'invoice.paid', data: { object: inv } });
    assert.deepEqual([a.type, a.subscription, a.userId, a.until, a.first], ['renewed', 'sub_1', 'u1', 1_800_000_100_000, first]);
  }
  assert.deepEqual(eventAction({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: { user_id: 'u1' } } } }), { type: 'plus_ended', subscription: 'sub_1', userId: 'u1' });
  assert.equal(eventAction({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: true } } }).renews, false);
  assert.equal(eventAction({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'unpaid' } } }).type, 'plus_ended');
  assert.equal(eventAction({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', refunded: false } } }).type, 'ignored'); // parcial
  assert.deepEqual(eventAction({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', refunded: true } } }), { type: 'refunded', paymentRef: 'pi_1' });
  assert.deepEqual(eventAction({ type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_1' } } }), { type: 'refunded', paymentRef: 'pi_1' });
  assert.equal(eventAction({ type: 'payment_intent.created', data: { object: {} } }).type, 'ignored');
});

test('checkout: precio y metadatos en la sesión, y vuelve al mismo dominio del que salió', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: new URLSearchParams(init.body) });
    return { ok: true, json: async () => ({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }) };
  };
  const pay = createPayments({ secretKey: 'sk_test_x', fetchImpl });
  const out = await pay.createCheckout({ userId: 'u1', product: 'dia', lifeNo: 3, origin: 'https://time.cc', lang: 'es' });
  assert.equal(out.url, 'https://checkout.stripe.com/c/pay/cs_test_abc');
  const { url, init, body } = calls[0];
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(init.headers.Authorization, 'Bearer sk_test_x');
  assert.equal(body.get('mode'), 'payment');
  assert.equal(body.get('client_reference_id'), 'u1');
  assert.equal(body.get('metadata[product]'), 'dia');
  assert.equal(body.get('metadata[life_no]'), '3');
  assert.equal(body.get('line_items[0][price_data][unit_amount]'), String(PRODUCTS.dia.price));
  assert.equal(body.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(body.get('line_items[0][price_data][product_data][name]'), '+1 día de vida');
  assert.equal(body.get('success_url'), 'https://time.cc/?pago=ok&cs={CHECKOUT_SESSION_ID}');
  assert.equal(body.get('payment_intent_data[metadata][user_id]'), 'u1');

  await pay.createCheckout({ userId: 'u1', product: 'plus', lifeNo: 1, origin: 'http://127.0.0.1:3000', lang: 'en' });
  const plus = calls[1].body;
  assert.equal(plus.get('mode'), 'subscription');
  assert.equal(plus.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(plus.get('subscription_data[metadata][user_id]'), 'u1');
  assert.equal(plus.get('locale'), 'en');

  await assert.rejects(pay.getSession('../../v1/customers'), { status: 404 }); // ids raros ni se consultan
  assert.equal(calls.length, 2);
});

/* ───────── lo que se compra ───────── */

test('+1 día: se acredita una sola vez aunque el aviso llegue repetido, y no cuenta en el ranking', () => {
  const { store, user } = setup();
  const id = user('Nico');
  const before = left(store, id);
  const p = paid(id, 'dia');
  assert.equal(store.fulfill(p).seconds, 86_400);
  assert.equal(store.fulfill(p).duplicate, true); // webhook repetido
  assert.equal(left(store, id), before + DAY);
  const row = store.state(id).ledger[0];
  assert.deepEqual([row.category, row.seconds, row.status], ['compra', 86_400, 'comprado']);
  store.setRanked(id, true);
  const r = store.ranking(id, 'semana').rows[0];
  assert.equal(r.score, 0); // lo comprado no suma en la semana
  assert.equal(store.ranking(id, 'tiempo').rows[0].score * 1000, before); // ni en "más tiempo"
  assert.equal(store.purchaseOf(id, p.ref).status, 'pagado');
  assert.equal(store.purchaseOf(user('Otro'), p.ref), false); // la compra de otro no se ve
  assert.equal(store.purchaseOf(id, 'cs_no_existe'), null);
});

test('+1 día: máximo uno por semana y nunca en la última hora', () => {
  const { store, user, advance } = setup();
  const id = user('Nico');
  assert.deepEqual(store.checkBuy(id, 'dia'), { lifeNo: 1, lang: 'en' });
  store.fulfill(paid(id, 'dia'));
  assert.throws(() => store.checkBuy(id, 'dia'), { code: 'dia_limit' });
  advance(7 * DAY + 1000);
  assert.doesNotThrow(() => store.checkBuy(id, 'dia'));
  advance(left(store, id) - 30 * 60_000); // quedan 30 min
  assert.throws(() => store.checkBuy(id, 'dia'), { code: 'critical' });
  assert.throws(() => store.checkBuy(id, 'nada'), { code: 'product' });
});

test('revivir: solo en cero; vuelve con 1 día conservando la vida, el récord y el historial', () => {
  const { store, user, advance } = setup();
  const id = user('Nico');
  store.addTx(id, { category: 'ingreso', amount: 100_000, note: 'Venta' });
  assert.throws(() => store.checkBuy(id, 'revivir'), { code: 'alive' });
  advance(9 * DAY); // se acabó
  store.checkBuy(id, 'revivir');
  const r = store.fulfill(paid(id, 'revivir'));
  assert.equal(r.kind, 'revivir');
  const s = store.state(id);
  assert.equal(s.lifeNo, 1); // la misma vida
  assert.equal(s.expiresAt - s.now, DAY);
  assert.deepEqual(s.ledger.map((x) => x.category), ['revivir', 'ingreso']); // historial intacto
  assert.equal(s.record, 0);
});

test('regalo: un código para otra persona; el comprador no lo usa; cada quien recibe uno por semana', () => {
  const { store, user, advance } = setup();
  const nico = user('Nico');
  const pipe = user('Pipe');
  const { giftCode } = store.fulfill(paid(nico, 'regalo'));
  assert.match(giftCode, /^[A-Z2-9]{6}$/);
  assert.equal(left(store, nico), 7 * DAY); // al comprador no se le suma
  assert.throws(() => store.claimTransfer(nico, giftCode), { code: 'own' });
  const before = left(store, pipe);
  const r = store.claimTransfer(pipe, giftCode.toLowerCase());
  assert.deepEqual([r.seconds, r.gift, r.fromName], [7 * 86_400, true, 'Nico']);
  assert.equal(left(store, pipe), before + 7 * DAY);
  assert.deepEqual([r.state.ledger[0].category, r.state.ledger[0].note], ['regalo', 'Regalo de Nico']);
  assert.throws(() => store.claimTransfer(user('Ana'), giftCode), { code: 'code' }); // un solo uso
  assert.equal(store.storeInfo(nico).gifts[0].toName, 'Pipe');

  const second = store.fulfill(paid(nico, 'regalo')).giftCode;
  assert.throws(() => store.claimTransfer(pipe, second), { code: 'gift_limit' }); // uno por semana
  advance(7 * DAY + 1000);
  assert.equal(store.claimTransfer(pipe, second).seconds, 7 * 86_400);
});

test('reembolso o contracargo: se descuenta lo acreditado, se anulan regalos y se acaba Plus', () => {
  const { store, user } = setup();
  const nico = user('Nico');
  const pipe = user('Pipe');
  const dia = paid(nico, 'dia');
  store.fulfill(dia);
  assert.equal(store.refund(dia.paymentRef), 1);
  assert.equal(left(store, nico), 7 * DAY);
  assert.equal(store.state(nico).ledger[0].category, 'reembolso');
  assert.equal(store.refund(dia.paymentRef), 0); // idempotente
  assert.equal(store.purchaseOf(nico, dia.ref).status, 'reembolsado');

  const g1 = paid(nico, 'regalo');
  const unused = store.fulfill(g1).giftCode;
  store.refund(g1.paymentRef);
  assert.throws(() => store.claimTransfer(pipe, unused), { code: 'code' }); // anulado

  const g2 = paid(nico, 'regalo');
  const used = store.fulfill(g2).giftCode;
  store.claimTransfer(pipe, used);
  store.refund(g2.paymentRef);
  assert.equal(left(store, pipe), 7 * DAY); // se le quita a quien lo recibió

  const plus = paid(nico, 'plus', { subscription: 'sub_9' });
  store.fulfill(plus);
  assert.equal(store.state(nico).plus.active, true);
  store.refund(plus.paymentRef);
  assert.equal(store.state(nico).plus.active, false);
});

test('Plus: 15 charlas y 3 réplicas, Revivir gratis al mes, renovación y fin; nunca da tiempo', () => {
  const { store, user, advance, now } = setup();
  const id = user('Nico');
  const before = left(store, id);
  store.fulfill(paid(id, 'plus', { subscription: 'sub_1' }));
  let s = store.state(id);
  assert.deepEqual([s.plus.active, s.plus.renews, s.daysPerDay, s.maxReplies, s.expiresAt - s.now], [true, true, 15, 3, before]);
  assert.throws(() => store.checkBuy(id, 'plus'), { code: 'plus_active' });
  for (let i = 0; i < 8; i++) store.openDay(id, { text: `charla ${i}` }); // más de 7
  const day = store.openDay(id, { text: 'réplicas' }).id;
  for (let i = 0; i < 3; i++) {
    store.saveVerdict(day, { message: 'ok', items: [] });
    store.replyDay(id, day, { text: `réplica ${i + 1}` });
  }
  store.saveVerdict(day, { message: 'ok', items: [] });
  assert.throws(() => store.replyDay(id, day, { text: 'cuarta' }), { code: 'final' });
  assert.equal(store.judgeInput(id, store.openDay(id, { text: 'x' }).id).plus, true); // Guardián Plus

  const until = now() + 30 * DAY;
  store.renewPlus({ subscription: 'sub_1', ref: 'in_1', until, first: true });
  assert.equal(store.state(id).plus.until, until + 2 * DAY);
  store.setPlusRenews({ subscription: 'sub_1', renews: false });
  assert.equal(store.state(id).plus.renews, false);
  assert.equal(store.plusSubOf(id), 'sub_1');

  advance(8 * DAY); // se acabó el reloj
  assert.equal(store.state(id).plus.freeRevive, true);
  s = store.reviveFree(id).state;
  assert.deepEqual([s.lifeNo, s.expiresAt - s.now, s.plus.freeRevive], [1, DAY, false]);
  advance(2 * DAY);
  assert.throws(() => store.reviveFree(id), { code: 'plus_revive' }); // uno por mes

  store.endPlus({ subscription: 'sub_1' });
  s = store.state(id);
  assert.deepEqual([s.plus.active, s.daysPerDay, s.maxReplies], [false, 7, 2]);
  assert.throws(() => store.plusSubOf(id), { code: 'no_plus' });
});
