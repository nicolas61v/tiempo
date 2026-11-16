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

/* ───────── webhook de Lemon Squeezy ───────── */

const SECRET = 'secreto_de_prueba_000';
const VARIANTS = { plus: '11', dia: '22', regalo: '33', revivir: '44' };
const sign = (raw, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
const ev = (event_name, attributes, { id = '900', custom = {} } = {}) => ({
  meta: { event_name, custom_data: custom, test_mode: true },
  data: { type: 'x', id, attributes },
});

test('webhook: solo pasa con la firma de Lemon Squeezy sobre el cuerpo exacto', () => {
  const raw = JSON.stringify(ev('order_created', { status: 'paid', first_order_item: { variant_id: 22 } }));
  assert.doesNotThrow(() => verifySignature(Buffer.from(raw), sign(raw), SECRET));
  assert.doesNotThrow(() => verifySignature(Buffer.from(raw), sign(raw).toUpperCase(), SECRET));
  const bad = { code: 'signature', status: 400 };
  assert.throws(() => verifySignature(Buffer.from(raw + ' '), sign(raw), SECRET), bad); // cuerpo alterado
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw, 'otro'), SECRET), bad); // otro secreto
  assert.throws(() => verifySignature(Buffer.from(raw), `${sign(raw)}zz`, SECRET), bad); // con basura
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw).slice(2), SECRET), bad); // incompleta
  assert.throws(() => verifySignature(Buffer.from(raw), '', SECRET), bad);
  assert.throws(() => verifySignature(Buffer.from(raw), sign(raw), ''), bad);

  const pay = createPayments({ apiKey: 'k', webhookSecret: SECRET, variants: VARIANTS });
  assert.deepEqual([pay.enabled, pay.webhookReady, pay.missing], [true, true, []]);
  const out = pay.parseWebhook(Buffer.from(raw), sign(raw));
  assert.deepEqual([out.type, out.livemode, out.action.type, out.action.product], ['order_created', false, 'paid', 'dia']);

  const off = createPayments({ apiKey: 'k', variants: { plus: '11' } });
  assert.equal(off.enabled, false); // sin webhook no se acredita nada: la tienda no abre
  assert.deepEqual(off.missing, ['LEMONSQUEEZY_WEBHOOK_SECRET', 'LEMONSQUEEZY_VARIANT_DIA', 'LEMONSQUEEZY_VARIANT_REGALO', 'LEMONSQUEEZY_VARIANT_REVIVIR']);
});

test('webhook: traduce cada evento de Lemon Squeezy a una acción de la app', () => {
  const ref = ck();
  const order = { status: 'paid', total_usd: 99, first_order_item: { variant_id: 22 } };
  assert.deepEqual(eventAction(ev('order_created', order, { id: '7', custom: { user_id: 'u1', product: 'dia', ref } }), VARIANTS), {
    type: 'paid', ref, userId: 'u1', product: 'dia', paymentRef: 'order_7', subscription: '', amount: 99, currency: 'usd',
  });
  // El producto sale de la variante pagada, no de lo que diga el checkout (el link público deja escribir cualquier cosa).
  const trampa = eventAction(ev('order_created', order, { id: '8', custom: { user_id: 'u1', product: 'regalo', ref: 'x' } }), VARIANTS);
  assert.deepEqual([trampa.product, trampa.ref], ['dia', 'order_8']);
  assert.equal(eventAction(ev('order_created', { ...order, first_order_item: { variant_id: 99 } }), VARIANTS).type, 'ignored'); // otro producto de la tienda
  assert.equal(eventAction(ev('order_created', { ...order, status: 'pending' }), VARIANTS).type, 'pending');
  assert.deepEqual(eventAction(ev('order_refunded', { status: 'refunded' }, { id: '7' }), VARIANTS), { type: 'refunded', paymentRef: 'order_7' });
  assert.equal(eventAction(ev('order_refunded', { status: 'partial_refund' }, { id: '7' }), VARIANTS).type, 'ignored'); // parcial

  const sub = (status, extra = {}) =>
    eventAction(ev('subscription_updated', { status, variant_id: 11, renews_at: '2027-01-15T12:00:00.000000Z', ...extra }, { id: '55', custom: { user_id: 'u1' } }), VARIANTS);
  assert.deepEqual(sub('active'), { type: 'renewed', subscription: '55', userId: 'u1', ref: '', until: Date.UTC(2027, 0, 15, 12), first: true });
  assert.deepEqual(sub('cancelled'), { type: 'plus_renews', subscription: '55', userId: 'u1', renews: false });
  assert.equal(sub('past_due').type, 'ignored');
  for (const st of ['expired', 'unpaid', 'paused']) assert.equal(sub(st).type, 'plus_ended');
  assert.equal(sub('active', { variant_id: 22 }).type, 'ignored'); // no es la suscripción de Plus

  const inv = (billing_reason) => eventAction(ev('subscription_payment_success', { subscription_id: 55, billing_reason, total_usd: 299 }, { id: '3' }), VARIANTS);
  const renewal = inv('renewal');
  assert.deepEqual([renewal.type, renewal.subscription, renewal.ref, renewal.amount, renewal.first], ['renewed', '55', 'invoice_3', 299, false]);
  assert.equal(inv('initial').first, true); // el primer mes ya quedó con order_created
  assert.deepEqual(eventAction(ev('subscription_payment_refunded', { subscription_id: 55, status: 'refunded' }), VARIANTS), { type: 'plus_ended', subscription: '55', userId: '' });
  assert.equal(eventAction(ev('subscription_payment_failed', {}), VARIANTS).type, 'ignored');
  assert.equal(eventAction(ev('license_key_created', {}), VARIANTS).type, 'ignored');
});

test('checkout: precio, variante y datos en el pago; vuelve al mismo dominio con su referencia', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/stores')) return { ok: true, json: async () => ({ data: [{ id: 77, attributes: { name: 'Tiempo' } }] }) };
    return { ok: true, json: async () => ({ data: { id: 'abc', attributes: { url: 'https://tiempo.lemonsqueezy.com/checkout/custom/abc', test_mode: true } } }) };
  };
  const t = Date.UTC(2026, 10, 15, 12);
  const pay = createPayments({ apiKey: 'llave', webhookSecret: SECRET, variants: VARIANTS, fetchImpl, now: () => t });
  assert.equal(pay.testMode, false);
  const out = await pay.createCheckout({ userId: 'u1', product: 'dia', lifeNo: 3, origin: 'https://time.cc', lang: 'es' });
  assert.equal(out.url, 'https://tiempo.lemonsqueezy.com/checkout/custom/abc');
  assert.match(out.ref, /^ck_[a-f0-9]{32}$/);
  assert.equal(pay.testMode, true);
  assert.equal(calls[0].url, 'https://api.lemonsqueezy.com/v1/stores'); // la tienda se descubre sola
  const { url, init, body } = calls[1];
  assert.equal(url, 'https://api.lemonsqueezy.com/v1/checkouts');
  assert.equal(init.headers.Authorization, 'Bearer llave');
  assert.equal(init.headers.Accept, 'application/vnd.api+json');
  const a = body.data.attributes;
  assert.equal(a.custom_price, PRODUCTS.dia.price);
  assert.equal(a.product_options.name, '+4 días de vida');
  assert.equal(a.product_options.redirect_url, `https://time.cc/?pago=ok&ck=${out.ref}`);
  assert.deepEqual(a.checkout_data.custom, { user_id: 'u1', product: 'dia', life_no: '3', ref: out.ref });
  assert.equal(a.expires_at, new Date(t + 6 * HOUR).toISOString());
  assert.deepEqual(body.data.relationships.store.data, { type: 'stores', id: '77' });
  assert.deepEqual(body.data.relationships.variant.data, { type: 'variants', id: '22' });

  await pay.createCheckout({ userId: 'u1', product: 'plus', lifeNo: 1, origin: 'http://127.0.0.1:3000', lang: 'en' });
  assert.equal(calls.length, 3); // la tienda ya quedó guardada
  assert.equal(calls[2].body.data.attributes.product_options.name, 'Tiempo Plus (monthly)');
  assert.equal(calls[2].body.data.relationships.variant.data.id, '11');
  await assert.rejects(pay.createCheckout({ userId: 'u1', product: 'nada', lifeNo: 1, origin: 'x', lang: 'en' }), { code: 'product' });

  // Plus: cancelar la renovación es DELETE; retomarla, PATCH con cancelled: false.
  await pay.setRenewal('55', false);
  await pay.setRenewal('55', true);
  assert.deepEqual([calls[3].init.method, calls[3].url], ['DELETE', 'https://api.lemonsqueezy.com/v1/subscriptions/55']);
  assert.deepEqual([calls[4].init.method, calls[4].body.data.attributes], ['PATCH', { cancelled: false }]);
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
  store.renewPlus({ subscription: '1', ref: 'invoice_1', until, first: true });
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
