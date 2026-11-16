// Pagos con Creem (creem.io), sin dependencias: API JSON con la llave en el encabezado x-api-key y webhooks firmados
// con HMAC-SHA256. Creem es el "comerciante registrado": cobra, maneja los impuestos de cada país y le paga al dueño
// (por banco o en USDC), y acepta personas naturales de Colombia. Antes fue Stripe (no abre en Colombia) y Lemon
// Squeezy (cerró a tiendas nuevas al unirse a Stripe).
//
// Variables (en Railway → Variables, nunca en el repo ni por chat). Pasos en el README:
//   CREEM_API_KEY          llave de la API (Developers → API keys). La de prueba usa test-api.creem.io.
//   CREEM_WEBHOOK_SECRET   el secreto del webhook https://app.mylifetime.cc/api/creem/webhook (Developers → Webhooks)
//   CREEM_PRODUCT_PLUS · _DIA · _REGALO · _REVIVIR   id (prod_…) de cada producto creado en el panel
//   CREEM_TEST_MODE        opcional: 1 o 0 para forzar prueba o real (si no, se deduce de la llave: creem_test_…)
// Los productos se crean en el panel con los mismos precios de PRODUCTS: el checkout cobra el precio del producto.
// Al arrancar, check() revisa cada producto (que exista, el tipo, el precio y la moneda) y deja en los logs qué arreglar.
//
// Capa intercambiable: createCheckout / parseWebhook devuelven acciones propias de la app
// ('paid', 'renewed', 'plus_ended', 'plus_renews', 'refunded'), así otro proveedor podría reemplazar a este.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './store.js';

export const PROVIDER = 'creem';

/** Precios en centavos de dólar. En el panel de Creem van los mismos (check() avisa si no cuadran). */
export const CURRENCY = 'usd';
export const PRODUCTS = {
  plus: {
    mode: 'subscription',
    price: 499,
    name: { es: 'Tiempo Plus (mensual)', en: 'Tiempo Plus (monthly)' },
  },
  dia: {
    mode: 'payment',
    price: 299,
    name: { es: '+4 días de vida', en: '+4 days of life' },
  },
  regalo: {
    mode: 'payment',
    price: 499,
    name: { es: 'Regalo: 1 semana de vida', en: 'Gift: 1 week of life' },
  },
  revivir: {
    mode: 'payment',
    price: 499,
    name: { es: 'Revivir', en: 'Revive' },
  },
};

export const API_LIVE = 'https://api.creem.io/v1';
export const API_TEST = 'https://test-api.creem.io/v1';
/** Referencia propia de cada checkout: viaja como request_id, en los metadatos y en la URL de vuelta. */
export const CHECKOUT_REF = /^ck_[a-f0-9]{32}$/;

const badSignature = () => new AppError(400, 'signature', 'Firma inválida', 'Invalid signature');

/** Verifica el encabezado creem-signature (HMAC-SHA256 en hex del cuerpo crudo). Lanza 400 si no cuadra. */
export function verifySignature(raw, header, secret) {
  const sig = String(header || '').trim();
  if (!secret || !/^[a-f0-9]{64}$/i.test(sig)) throw badSignature();
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), expected)) throw badSignature();
}

const ms = (iso) => {
  const t = typeof iso === 'number' ? iso : Date.parse(iso || '');
  return Number.isFinite(t) ? t : NaN;
};
/** Creem manda a veces el objeto entero y a veces solo su id. */
const idOf = (x) => String((x && typeof x === 'object' ? x.id : x) ?? '');

/** Qué producto de la app es un producto de Creem ('' si no es de los configurados). */
const productOf = (products, productId) =>
  Object.keys(PRODUCTS).find((k) => products[k] && String(products[k]) === String(productId || '')) || '';

/**
 * Traduce un evento de Creem a una acción de la app. `products` = { plus, dia, regalo, revivir } (ids prod_…).
 * Lo que se entrega sale del producto pagado, no de los metadatos (el link público de un producto también vende,
 * pero no deja cambiar qué producto ni a qué precio).
 *
 * Referencias de pago: la de un cobro es su transacción (tran_…), que es lo que traen los reembolsos y las
 * renovaciones de Plus; así un reembolso encuentra lo que acreditó, y el primer cobro de Plus no se cuenta dos
 * veces (llega con el checkout y otra vez como subscription.paid).
 */
export function eventAction(event, products = {}) {
  const o = event?.object || {};
  const meta = o.metadata && typeof o.metadata === 'object' ? o.metadata : {};
  const userId = String(meta.user_id || '');
  switch (event?.eventType) {
    case 'checkout.completed': {
      const order = o.order || {};
      if (order.status !== 'paid') return { type: 'pending' };
      const product = productOf(products, idOf(o.product) || order.product);
      const orderId = idOf(order);
      if (!product || !orderId) return { type: 'ignored' };
      const ref = CHECKOUT_REF.test(o.request_id) ? o.request_id : CHECKOUT_REF.test(meta.ref) ? meta.ref : orderId;
      return {
        type: 'paid',
        ref,
        userId,
        product,
        paymentRef: idOf(order.transaction) || orderId,
        subscription: idOf(o.subscription),
        amount: order.amount_paid ?? order.amount ?? 0,
        currency: String(order.currency || CURRENCY).toLowerCase(),
      };
    }

    case 'subscription.paid': {
      if (!o.id || productOf(products, idOf(o.product)) !== 'plus') return { type: 'ignored' };
      const t = o.last_transaction || {};
      return {
        type: 'renewed',
        subscription: String(o.id),
        userId,
        ref: String(o.last_transaction_id || t.id || ''),
        until: ms(o.current_period_end_date),
        amount: t.amount_paid ?? t.amount ?? 0,
        currency: String(t.currency || CURRENCY).toLowerCase(),
      };
    }
    case 'subscription.active':
    case 'subscription.trialing':
    case 'subscription.update':
    case 'subscription.scheduled_cancel':
    case 'subscription.canceled':
    case 'subscription.expired':
    case 'subscription.paused':
    case 'subscription.unpaid':
    case 'subscription.past_due': {
      if (!o.id || productOf(products, idOf(o.product)) !== 'plus') return { type: 'ignored' };
      const sub = { subscription: String(o.id), userId };
      if (event.eventType === 'subscription.scheduled_cancel' || o.status === 'scheduled_cancel') {
        return { type: 'plus_renews', ...sub, renews: false }; // sigue hasta lo ya pagado
      }
      if (event.eventType === 'subscription.past_due' || o.status === 'past_due') {
        return { type: 'ignored' }; // Creem reintenta el cobro; Plus dura lo pagado + 2 días de margen
      }
      // expired: el periodo pagado se acabó y no llegó el cobro siguiente (llega hasta un día después)
      if (['subscription.canceled', 'subscription.expired', 'subscription.paused', 'subscription.unpaid'].includes(event.eventType)) {
        return { type: 'plus_ended', ...sub };
      }
      if (o.status === 'active' || o.status === 'trialing') {
        // activa (o retomada): pagada hasta el fin del periodo, y se renueva sola
        return { type: 'renewed', ...sub, ref: '', until: ms(o.current_period_end_date) };
      }
      return o.status === 'canceled' || o.status === 'paused' || o.status === 'unpaid' ? { type: 'plus_ended', ...sub } : { type: 'ignored' };
    }

    case 'refund.created': {
      // Solo el reembolso completo deshace la compra (uno parcial es una decisión del dueño, se deja igual).
      const t = o.transaction && typeof o.transaction === 'object' ? o.transaction : {};
      const paidAmount = t.amount_paid ?? t.amount;
      const full = t.status === 'refunded' || (Number.isFinite(paidAmount) && Number(o.refund_amount) >= paidAmount);
      const refs = [idOf(o.transaction), idOf(t.order)].filter(Boolean);
      return full && refs.length ? { type: 'refunded', paymentRefs: refs } : { type: 'ignored' };
    }
    case 'dispute.created': {
      // Contracargo: el banco ya le devolvió la plata a quien pagó, así que se deshace igual que un reembolso.
      const refs = [idOf(o.transaction), idOf(o.order)].filter(Boolean);
      return refs.length ? { type: 'refunded', paymentRefs: refs } : { type: 'ignored' };
    }
    default:
      return { type: 'ignored' };
  }
}

export function createPayments({ apiKey = '', webhookSecret = '', products = {}, testMode: force = '', fetchImpl = fetch, log = console } = {}) {
  const testKey = force === '1' || force === true || (force !== '0' && force !== false && /^creem_test_/.test(apiKey));
  const API = testKey ? API_TEST : API_LIVE;
  let testMode = testKey;
  const missing = [
    !apiKey && 'CREEM_API_KEY',
    !webhookSecret && 'CREEM_WEBHOOK_SECRET',
    ...Object.keys(PRODUCTS)
      .filter((k) => !products[k])
      .map((k) => `CREEM_PRODUCT_${k.toUpperCase()}`),
  ].filter(Boolean);

  async function creem(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      log.warn('creem sin conexión:', err.message);
      throw new AppError(502, 'payments', 'No pudimos conectar con el pago. Intenta de nuevo.', "Couldn't reach the payment provider. Try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = [data?.message, data?.error, data?.trace_id && `trace ${data.trace_id}`].flat().filter(Boolean).join(' · ');
      log.warn('creem', method, path.split('?')[0], res.status, why);
      if (res.status === 404) throw new AppError(404, 'not_found', 'Ese pago no existe', "That payment doesn't exist");
      throw new AppError(502, 'payments', 'El pago no se pudo iniciar. Intenta de nuevo.', "Couldn't start the payment. Try again.");
    }
    return data;
  }

  return {
    provider: PROVIDER,
    enabled: !missing.length,
    webhookReady: Boolean(webhookSecret),
    missing,
    get testMode() {
      return testMode;
    },

    /** Página de pago de Creem (redirección, no iframe: no hay que abrir la CSP). */
    async createCheckout({ userId, product, lifeNo, origin }) {
      if (!PRODUCTS[product] || !products[product]) throw new AppError(400, 'product', 'Producto desconocido', 'Unknown product');
      const ref = `ck_${randomBytes(16).toString('hex')}`;
      const out = await creem('POST', '/checkouts', {
        product_id: String(products[product]),
        request_id: ref,
        units: 1,
        // Vuelve al mismo dominio del que salió: ahí está el reloj (cada dominio guarda sus relojes).
        success_url: `${origin}/?pago=ok&ck=${ref}`,
        metadata: { user_id: userId, product, life_no: String(lifeNo), ref },
      });
      if (!out?.checkout_url) throw new AppError(502, 'payments', 'El pago no se pudo iniciar. Intenta de nuevo.', "Couldn't start the payment. Try again.");
      if (out.mode) testMode = out.mode !== 'prod';
      return { ref, url: out.checkout_url };
    },

    /** Que Plus no se renueve (sigue hasta el fin del mes pagado) o que vuelva a renovarse. */
    async setRenewal(subscription, renews) {
      const path = `/subscriptions/${encodeURIComponent(subscription)}`;
      if (renews) await creem('POST', `${path}/resume`);
      else await creem('POST', `${path}/cancel`, { mode: 'scheduled', onExecute: 'cancel' });
    },

    /** Verifica la firma y traduce el evento. Lanza 400 si la firma no es de Creem. */
    parseWebhook(raw, signature) {
      verifySignature(raw, signature, webhookSecret);
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError(400, 'json', 'JSON inválido', 'Invalid JSON');
      }
      return {
        type: String(event?.eventType || ''),
        id: String(event?.id || ''),
        action: eventAction(event, products),
      };
    },

    /**
     * Al arrancar: revisa cada producto configurado (que exista en esta modalidad, que Plus sea la suscripción
     * mensual y los demás pago único, el precio y la moneda) y deja en los logs lo que haya que arreglar.
     */
    async check() {
      if (!apiKey) return [];
      const problems = [];
      for (const [product, p] of Object.entries(PRODUCTS)) {
        const id = products[product];
        if (!id) continue;
        let x;
        try {
          x = await creem('GET', `/products/${encodeURIComponent(id)}`);
        } catch {
          problems.push(`el producto ${id} de ${product} no existe o la llave no lo ve (¿es de la otra modalidad, prueba o real?)`);
          continue;
        }
        if (x.mode) testMode = x.mode !== 'prod';
        const sub = p.mode === 'subscription';
        if (x.billing_type && x.billing_type !== (sub ? 'recurring' : 'onetime')) {
          problems.push(`el producto ${id} de ${product} ${sub ? 'debe ser una suscripción (recurring) mensual' : 'debe ser de pago único (one-time)'}`);
        }
        if (sub && x.billing_period && x.billing_period !== 'every-month') {
          problems.push(`el producto ${id} de ${product} debe cobrarse cada mes (está en ${x.billing_period})`);
        }
        if (x.currency && String(x.currency).toUpperCase() !== CURRENCY.toUpperCase()) {
          problems.push(`el producto ${id} de ${product} está en ${x.currency}: debe ser en USD`);
        }
        if (Number.isFinite(x.price) && x.price !== p.price) {
          problems.push(`el producto ${id} de ${product} cuesta US$${(x.price / 100).toFixed(2)} en el panel y la app cobra US$${(p.price / 100).toFixed(2)}: ponle el mismo precio`);
        }
        if (x.status && x.status !== 'active') problems.push(`el producto ${id} de ${product} está ${x.status}: actívalo`);
      }
      for (const msg of problems) log.warn(`⚠ Creem: ${msg}.`);
      if (!missing.length && !problems.length) log.info(`pagos con Creem listos${testMode ? ' (modo de prueba)' : ' (modo real)'}`);
      return problems;
    },
  };
}
