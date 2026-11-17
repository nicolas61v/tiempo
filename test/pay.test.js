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
const ck = () => `ck_${String(++refs).padStart(32, '0')}`;
const paid = (userId, product, extra = {}) => ({ ref: ck(), userId, product, paymentRef: `order_${refs}`, amount: PRODUCTS[product].price, currency: 'usd', ...extra });

/* ───────── webhook de Creem ───────── */

const SECRET = 'whsec_de_prueba_000';
const PRODS = { plus: 'prod_plus', dia: 'prod_dia', regalo: 'prod_regalo', revivir: 'prod_revivir' };
const sign = (raw, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
const ev = (eventType, object, id = 'evt_1') => ({ id, eventType, created_at: 1_800_000_000_000, object });
/** Un checkout.completed como los de la documentación de Creem. */
const done = ({ product = 'prod_dia', ref, meta = {}, status = 'paid', sub = null, order = 'ord_7', tran = 'tran_7' } = {}) =>
  ev('checkout.completed', {
    id: 'ch_1',
    object: 'checkout',
    request_id: ref,
    order: { id: order, product, amount: 299, amount_paid: 299, currency: 'USD', status, type: sub ? 'recurring' : 'onetime', transaction: tran },
    product: { id: product, object: 'product', price: 299, currency: 'USD' },
    customer: { id: 'cust_1', email: 'x@y.z' },
    subscription: sub,
    status: 'completed',
    metadata: meta,
  });
/** Un evento de la suscripción de Plus. */
const subEv = (eventType, status, extra = {}) =>
  ev(eventType, {
    id: 'sub_9',
    object: 'subscription',
    product: { id: 'prod_plus' },
    status,
    current_period_end_date: '2027-01-15T12:00:00.000Z',
    metadata: { user_id: 'u1' },
    ...extra,
  });

test('webhook: solo pasa con la firma de Creem sobre el cuerpo exacto', () => {
  const raw = JSON.stringify(done({ ref: ck() }));
  assert.doesNotThrow(() => verifySignature(Buffer.from(raw), sign(raw), SECRET));
  assert.doesNotThrow(() => verifySignature(Buffer.from(raw), sign(raw).toUpperCase(), SECRET));
  const bad = { code: 'signature', status: 400 };
  assert.throws(() => verifySignature(Buffer.from(raw + ' '), sign(raw), SECRET), bad); // cuerpo alterado
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw, 'otro'), SECRET), bad); // otro secreto
  assert.throws(() => verifySignature(Buffer.from(raw), `${sign(raw)}zz`, SECRET), bad); // con basura
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw).slice(2), SECRET), bad); // incompleta
  assert.throws(() => verifySignature(Buffer.from(raw), '', SECRET), bad);
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw), ''), bad);

  const pay = createPayments({ apiKey: 'creem_test_k', webhookSecret: SECRET, products: PRODS });
  assert.deepEqual([pay.enabled, pay.webhookReady, pay.missing, pay.testMode], [true, true, [], true]);
  const out = pay.parseWebhook(Buffer.from(raw), sign(raw));
  assert.deepEqual([out.type, out.id, out.action.type, out.action.product], ['checkout.completed', 'evt_1', 'paid', 'dia']);

  const off = createPayments({ apiKey: 'creem_k', products: { plus: 'prod_plus' } });
  assert.equal(off.enabled, false); // sin webhook no se acredita nada: la tienda no abre
  assert.equal(off.testMode, false); // una llave que no es de prueba va a la API real
  assert.deepEqual(off.missing, ['CREEM_WEBHOOK_SECRET', 'CREEM_PRODUCT_DIA', 'CREEM_PRODUCT_REGALO', 'CREEM_PRODUCT_REVIVIR']);
  assert.equal(createPayments({ apiKey: 'creem_k', testMode: '1' }).testMode, true); // CREEM_TEST_MODE=1 la fuerza
});

test('webhook: traduce cada evento de Creem a una acción de la app', () => {
  const ref = ck();
  assert.deepEqual(eventAction(done({ ref, meta: { user_id: 'u1', product: 'dia', ref } }), PRODS), {
    type: 'paid', ref, userId: 'u1', product: 'dia', paymentRef: 'tran_7', subscription: '', amount: 299, currency: 'usd',
  });
  // El producto sale del producto pagado, no de los metadatos (el link público del producto también vende).
  const trampa = eventAction(done({ meta: { user_id: 'u1', product: 'regalo', ref: 'x' }, order: 'ord_8', tran: 'tran_8' }), PRODS);
  assert.deepEqual([trampa.product, trampa.ref], ['dia', 'ord_8']);
  assert.equal(eventAction(done({ product: 'prod_otro' }), PRODS).type, 'ignored'); // otro producto de la tienda
  assert.equal(eventAction(done({ status: 'pending' }), PRODS).type, 'pending');
  // Plus: el checkout trae la suscripción (objeto o id) y el primer cobro.
  const plus = eventAction(done({ product: 'prod_plus', ref, meta: { user_id: 'u1' }, sub: { id: 'sub_9', status: 'active' } }), PRODS);
  assert.deepEqual([plus.product, plus.subscription, plus.paymentRef], ['plus', 'sub_9', 'tran_7']);
  assert.equal(eventAction(done({ product: 'prod_plus', sub: 'sub_9' }), PRODS).subscription, 'sub_9');

  // Cada cobro de Plus (también el primero) llega como subscription.paid, con su transacción y el fin del periodo.
  const until = Date.UTC(2027, 0, 15, 12);
  assert.deepEqual(eventAction(subEv('subscription.paid', 'active', { last_transaction_id: 'tran_2', last_transaction: { id: 'tran_2', amount_paid: 499 } }), PRODS), {
    type: 'renewed', subscription: 'sub_9', userId: 'u1', ref: 'tran_2', until, amount: 499, currency: 'usd',
  });
  assert.deepEqual(eventAction(subEv('subscription.active', 'active'), PRODS), { type: 'renewed', subscription: 'sub_9', userId: 'u1', ref: '', until });
  assert.deepEqual(eventAction(subEv('subscription.scheduled_cancel', 'scheduled_cancel'), PRODS), { type: 'plus_renews', subscription: 'sub_9', userId: 'u1', renews: false });
  assert.deepEqual(eventAction(subEv('subscription.update', 'scheduled_cancel'), PRODS).type, 'plus_renews');
  assert.equal(eventAction(subEv('subscription.past_due', 'past_due'), PRODS).type, 'ignored'); // Creem reintenta
  for (const [type, st] of [['subscription.canceled', 'canceled'], ['subscription.expired', 'active'], ['subscription.paused', 'paused'], ['subscription.unpaid', 'unpaid']]) {
    assert.equal(eventAction(subEv(type, st), PRODS).type, 'plus_ended', type);
  }
  assert.equal(eventAction(subEv('subscription.paid', 'active', { product: { id: 'prod_dia' } }), PRODS).type, 'ignored'); // no es Plus

  // Reembolso completo: por la transacción y el pedido. Uno parcial no deshace la compra.
  const refund = (status, refund_amount) =>
    eventAction(ev('refund.created', { id: 'ref_1', object: 'refund', status: 'succeeded', refund_amount, transaction: { id: 'tran_7', order: 'ord_7', amount_paid: 299, status } }), PRODS);
  assert.deepEqual(refund('refunded', 299), { type: 'refunded', paymentRefs: ['tran_7', 'ord_7'] });
  assert.equal(refund('partialRefund', 100).type, 'ignored');
  assert.deepEqual(eventAction(ev('dispute.created', { id: 'dis_1', transaction: 'tran_7', order: 'ord_7' }), PRODS), { type: 'refunded', paymentRefs: ['tran_7', 'ord_7'] });
  assert.equal(eventAction(ev('credits.granted', {}), PRODS).type, 'ignored');
});

test('checkout: producto, referencia y datos en el pago; vuelve al mismo dominio; Plus se cancela y se retoma', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/checkouts')) return { ok: true, json: async () => ({ id: 'ch_1', checkout_url: 'https://checkout.creem.io/ch_1', mode: 'test', status: 'pending' }) };
    return { ok: true, json: async () => ({ id: 'sub_9', status: 'active' }) };
  };
  const pay = createPayments({ apiKey: 'creem_k', webhookSecret: SECRET, products: PRODS, fetchImpl });
  assert.equal(pay.testMode, false);
  const out = await pay.createCheckout({ userId: 'u1', product: 'dia', lifeNo: 3, origin: 'https://app.mylifetime.cc', lang: 'es' });
  assert.equal(out.url, 'https://checkout.creem.io/ch_1');
  assert.match(out.ref, /^ck_[a-f0-9]{32}$/);
  assert.equal(pay.testMode, true); // Creem dice en qué modalidad quedó el checkout
  const { url, init, body } = calls[0];
  assert.deepEqual([init.method, url], ['POST', 'https://api.creem.io/v1/checkouts']);
  assert.equal(init.headers['x-api-key'], 'creem_k');
  assert.deepEqual(body, {
    product_id: 'prod_dia',
    request_id: out.ref,
    units: 1,
    success_url: `https://app.mylifetime.cc/?pago=ok&ck=${out.ref}`,
    metadata: { user_id: 'u1', product: 'dia', life_no: '3', ref: out.ref },
  });
  await assert.rejects(pay.createCheckout({ userId: 'u1', product: 'nada', lifeNo: 1, origin: 'x', lang: 'en' }), { code: 'product' });

  // Plus: cancelar la renovación la programa para el fin del periodo; retomarla es resume.
  await pay.setRenewal('sub_9', false);
  await pay.setRenewal('sub_9', true);
  assert.deepEqual([calls[1].init.method, calls[1].url, calls[1].body], ['POST', 'https://api.creem.io/v1/subscriptions/sub_9/cancel', { mode: 'scheduled', onExecute: 'cancel' }]);
  assert.deepEqual([calls[2].init.method, calls[2].url], ['POST', 'https://api.creem.io/v1/subscriptions/sub_9/resume']);

  // Una llave de prueba usa la API de prueba.
  const t = createPayments({ apiKey: 'creem_test_k', webhookSecret: SECRET, products: PRODS, fetchImpl });
  await t.createCheckout({ userId: 'u1', product: 'plus', lifeNo: 1, origin: 'http://127.0.0.1:3000', lang: 'en' });
  assert.equal(calls.at(-1).url, 'https://test-api.creem.io/v1/checkouts');
  assert.equal(calls.at(-1).body.product_id, 'prod_plus');
});

test('check(): avisa si un producto no cuadra con la app (tipo, periodo, moneda y precio)', async () => {
  const panel = {
    prod_plus: { id: 'prod_plus', mode: 'test', price: 299, currency: 'USD', billing_type: 'recurring', billing_period: 'every-year', status: 'active' },
    prod_dia: { id: 'prod_dia', mode: 'test', price: 299, currency: 'EUR', billing_type: 'recurring', status: 'active' },
    prod_regalo: { id: 'prod_regalo', mode: 'test', price: 499, currency: 'USD', billing_type: 'onetime', status: 'archived' },
  };
  const fetchImpl = async (url) => {
    const p = panel[url.split('/').pop()];
    return p ? { ok: true, json: async () => p } : { ok: false, status: 404, json: async () => ({ message: 'not found', trace_id: 't1' }) };
  };
  const warns = [];
  const log = { warn: (...a) => warns.push(a.join(' ')), info: () => {} };
  const pay = createPayments({ apiKey: 'creem_k', webhookSecret: SECRET, products: PRODS, fetchImpl, log });
  const problems = await pay.check();
  const has = (re) => assert.ok(problems.some((p) => re.test(p)), re);
  has(/prod_plus de plus cuesta US\$2\.99 .* US\$4\.99/);
  has(/prod_plus de plus debe cobrarse cada mes/);
  has(/prod_dia de dia debe ser de pago único/);
  has(/prod_dia de dia está en EUR/);
  has(/prod_regalo de regalo está archived/);
  has(/prod_revivir de revivir no existe/);
  assert.equal(pay.testMode, true);
  assert.ok(warns.some((w) => w.startsWith('⚠ Creem:')));
});

test('Plus con Creem: el primer cobro llega dos veces (checkout y subscription.paid) y cuenta una sola', () => {
  const { store, user } = setup();
  const id = user('Nico');
  const until = Date.UTC(2026, 11, 12, 12);
  // a) el checkout llega primero
  const a = paid(id, 'plus', { subscription: 'sub_a', paymentRef: 'tran_a1' });
  store.fulfill(a);
  store.renewPlus({ subscription: 'sub_a', userId: id, ref: 'tran_a1', until, amount: 499, currency: 'usd' });
  store.renewPlus({ subscription: 'sub_a', userId: id, ref: 'tran_a1', until, amount: 499, currency: 'usd' }); // aviso repetido
  assert.equal(store.storeInfo(id).purchases.filter((p) => p.product === 'plus').length, 1);
  assert.equal(store.state(id).plus.until, until + 2 * DAY);
  // b) en otra cuenta, subscription.paid llega antes que el checkout: la vuelta del pago igual la encuentra
  const otro = user('Pipe');
  store.renewPlus({ subscription: 'sub_b', userId: otro, ref: 'tran_b1', until, amount: 499, currency: 'usd' });
  const b = paid(otro, 'plus', { subscription: 'sub_b', paymentRef: 'tran_b1' });
  assert.equal(store.fulfill(b).product, 'plus');
  assert.equal(store.storeInfo(otro).purchases.length, 1);
  assert.equal(store.purchaseOf(otro, b.ref).status, 'pagado');
  assert.equal(store.fulfill(b).duplicate, true);
  // el mes siguiente es otra compra; y su reembolso termina Plus
  store.renewPlus({ subscription: 'sub_a', userId: id, ref: 'tran_a2', until: until + 30 * DAY, amount: 499, currency: 'usd' });
  assert.equal(store.storeInfo(id).purchases.filter((p) => p.product === 'plus').length, 2);
  assert.equal(store.refund('tran_a2'), 1);
  assert.equal(store.state(id).plus.active, false);
});

test('el mismo checkout pagado dos veces son dos compras; el aviso repetido de una, no', () => {
  const { store, user } = setup();
  const id = user('Nico');
  const before = left(store, id);
  const p = paid(id, 'regalo');
  assert.ok(store.fulfill(p).giftCode);
  assert.equal(store.fulfill(p).duplicate, true);
  assert.ok(store.fulfill({ ...p, paymentRef: 'order_otro' }).giftCode);
  assert.equal(store.fulfill({ ...p, paymentRef: 'order_otro' }).duplicate, true);
  assert.equal(store.storeInfo(id).gifts.length, 2);
  assert.equal(store.purchaseOf(id, p.ref).status, 'pagado'); // la vuelta del pago encuentra la primera
  assert.equal(left(store, id), before);
});

test('quien perdió su llave: /admin encuentra su reloj por la compra y le da una llave nueva sin tocar el reloj', () => {
  const { store } = setup();
  const created = store.createUser({ nickname: 'Nico' });
  const id = store.auth(created.token).id;
  const otro = store.auth(store.createUser({ nickname: 'Pipe' }).token).id;
  const dia = paid(id, 'dia', { paymentRef: 'tran_dia000001' });
  store.fulfill(dia);
  store.fulfill({ ...dia, paymentRef: 'tran_dia000002' }); // el mismo checkout pagado otra vez: "ck_…:tran_dia000002"
  store.fulfill(paid(id, 'plus', { subscription: 'sub_nico000001', paymentRef: 'tran_plus00001' }));
  store.fulfill(paid(otro, 'regalo', { paymentRef: 'tran_pipe00001' }));
  store.refund('tran_dia000001'); // reembolsada, igual dice de quién es

  for (const ref of ['tran_dia000001', 'tran_dia000002', 'tran_plus00001', 'sub_nico000001', dia.ref, ` ${dia.ref} `]) assert.equal(store.ownerOfPayment(ref), id, ref);
  assert.equal(store.ownerOfPayment('tran_pipe00001'), otro);
  assert.throws(() => store.ownerOfPayment('tran_noexiste'), { status: 404 });
  for (const bad of ['', 'ord_1234567', 'tran_', "tran_x' OR 1=1", 'prod_abcdefg']) assert.throws(() => store.ownerOfPayment(bad), { status: 400 }, bad);

  const before = store.state(id).expiresAt;
  const plusBefore = store.state(id).plus;
  const { token } = store.rotateToken(store.ownerOfPayment('sub_nico000001'));
  assert.equal(store.auth(created.token), null); // la llave perdida deja de servir
  assert.equal(store.auth(token).id, id);
  assert.equal(store.state(id).expiresAt, before); // regla 1: el reloj no cambia
  assert.deepEqual(store.state(id).plus, plusBefore);
});

/* ───────── lo que se compra ───────── */

test('+4 días: se acreditan una sola vez aunque el aviso llegue repetido, y no cuentan en el ranking', () => {
  const { store, user } = setup();
  const id = user('Nico');
  const before = left(store, id);
  const p = paid(id, 'dia');
  assert.equal(store.fulfill(p).seconds, 4 * 86_400);
  assert.equal(store.fulfill(p).duplicate, true); // webhook repetido
  assert.equal(left(store, id), before + 4 * DAY);
  const row = store.state(id).ledger[0];
  assert.deepEqual([row.category, row.seconds, row.status], ['compra', 4 * 86_400, 'comprado']);
  store.setRanked(id, true);
  const r = store.ranking(id, 'semana').rows[0];
  assert.equal(r.score, 0); // lo comprado no suma en la semana
  assert.equal(store.ranking(id, 'tiempo').rows[0].score * 1000, before); // ni en "más tiempo"
  assert.equal(store.purchaseOf(id, p.ref).status, 'pagado');
  assert.equal(store.purchaseOf(user('Otro'), p.ref), false); // la compra de otro no se ve
  assert.equal(store.purchaseOf(id, ck()), null);
});

test('+4 días: máximo una compra por semana y nunca en la última hora', () => {
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

  const plus = paid(nico, 'plus', { subscription: '9' });
  store.fulfill(plus);
  assert.equal(store.state(nico).plus.active, true);
  store.refund(plus.paymentRef);
  assert.equal(store.state(nico).plus.active, false);
});

test('Plus: 15 charlas y 3 réplicas, Revivir gratis al mes, renovación y fin; nunca da tiempo', () => {
  const { store, user, advance, now } = setup();
  const id = user('Nico');
  const before = left(store, id);
  store.fulfill(paid(id, 'plus', { subscription: '1' }));
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
  store.renewPlus({ subscription: '1', ref: 'tran_1', until });
  assert.equal(store.state(id).plus.until, until + 2 * DAY);
  store.setPlusRenews({ subscription: '1', renews: false });
  assert.equal(store.state(id).plus.renews, false);
  assert.equal(store.plusSubOf(id), '1');

  advance(8 * DAY); // se acabó el reloj
  assert.equal(store.state(id).plus.freeRevive, true);
  s = store.reviveFree(id).state;
  assert.deepEqual([s.lifeNo, s.expiresAt - s.now, s.plus.freeRevive], [1, DAY, false]);
  advance(2 * DAY);
  assert.throws(() => store.reviveFree(id), { code: 'plus_revive' }); // uno por mes

  store.endPlus({ subscription: '1' });
  s = store.state(id);
  assert.deepEqual([s.plus.active, s.daysPerDay, s.maxReplies], [false, 7, 2]);
  assert.throws(() => store.plusSubOf(id), { code: 'no_plus' });
});
