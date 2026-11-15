// Pagos con Stripe, sin dependencias: la API es REST con formularios y la firma del webhook es un HMAC.
//
// Solo hacen falta dos variables (en Railway → Variables, nunca en el repo ni por chat):
//   STRIPE_SECRET_KEY      sk_test_… (pruebas) o sk_live_… (real)
//   STRIPE_WEBHOOK_SECRET  whsec_… del endpoint https://<tu-dominio>/api/stripe/webhook
// Los productos y precios viven aquí (price_data en cada checkout): no hay que crear nada en el panel de Stripe.
//
// Capa intercambiable: createCheckout / getSession / parseWebhook devuelven acciones propias de la app
// ('paid', 'renewed', 'plus_ended', 'plus_renews', 'refunded'), así otro proveedor podría reemplazar a este.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './store.js';

/** Precios en centavos de dólar. Cambiarlos aquí cambia lo que cobra el próximo checkout. */
export const CURRENCY = 'usd';
export const PRODUCTS = {
  plus: {
    mode: 'subscription',
    price: 299,
    name: { es: 'Tiempo Plus (mensual)', en: 'Tiempo Plus (monthly)' },
    desc: {
      es: '15 charlas al día con el Guardián, 3 réplicas, el Guardián más fino y 1 Revivir gratis al mes.',
      en: '15 chats a day with the Guardian, 3 replies, the sharper Guardian and 1 free revive a month.',
    },
  },
  dia: {
    mode: 'payment',
    price: 99,
    name: { es: '+1 día de vida', en: '+1 day of life' },
    desc: { es: 'Máximo uno por semana. No cuenta en el ranking.', en: "Up to one a week. Doesn't count in the ranking." },
  },
  regalo: {
    mode: 'payment',
    price: 399,
    name: { es: 'Regalo: 1 semana de vida', en: 'Gift: 1 week of life' },
    desc: { es: 'Un código y un QR para regalarle una semana a quien quieras.', en: 'A code and a QR to give a week to anyone you want.' },
  },
  revivir: {
    mode: 'payment',
    price: 99,
    name: { es: 'Revivir', en: 'Revive' },
    desc: { es: 'Vuelves con 1 día y conservas tu vida, tu récord y tu historial.', en: 'Come back with 1 day and keep your life, record and history.' },
  },
};

const API = 'https://api.stripe.com/v1';
const TOLERANCE_S = 300; // una firma de hace más de 5 minutos no se acepta (contra reenvíos)

const idOf = (x) => (typeof x === 'string' ? x : x?.id || '');

/** { a: { b: [ { c: 1 } ] } } → a[b][0][c]=1, como espera la API de Stripe. */
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

const badSignature = () => new AppError(400, 'signature', 'Firma inválida', 'Invalid signature');

/** Verifica el encabezado Stripe-Signature (t=…,v1=…) contra el cuerpo crudo. Lanza 400 si no cuadra. */
export function verifySignature(raw, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(header || '').split(',').map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  });
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!secret || !Number.isFinite(t) || !sigs.length) throw badSignature();
  if (Math.abs(nowSec - t) > TOLERANCE_S) throw badSignature();
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw badSignature();
}

/** Lo que importa de una sesión de checkout. */
function sessionInfo(o) {
  return {
    ref: o.id,
    userId: o.client_reference_id || o.metadata?.user_id || '',
    product: o.metadata?.product || '',
    paid: o.payment_status === 'paid' || o.payment_status === 'no_payment_required',
    paymentRef: idOf(o.payment_intent),
    subscription: idOf(o.subscription),
    amount: o.amount_total ?? 0,
    currency: o.currency || '',
  };
}

/**
 * Traduce un evento de Stripe a una acción de la app. Soporta las dos formas de las facturas
 * (versiones de la API antes y después de 2025-03-31: invoice.subscription → invoice.parent.subscription_details).
 */
export function eventAction(event) {
  const o = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const s = sessionInfo(o);
      return s.paid ? { type: 'paid', ...s } : { type: 'pending' };
    }
    case 'invoice.paid': {
      const details = o.parent?.subscription_details || o.subscription_details || {};
      const subscription = idOf(o.subscription) || idOf(details.subscription);
      if (!subscription) return { type: 'ignored' };
      const ends = (o.lines?.data || []).map((l) => l?.period?.end).filter(Number.isFinite);
      return {
        type: 'renewed',
        subscription,
        userId: details.metadata?.user_id || '',
        ref: o.id,
        until: ends.length ? Math.max(...ends) * 1000 : NaN,
        amount: o.amount_paid ?? 0,
        currency: o.currency || '',
        first: o.billing_reason === 'subscription_create',
      };
    }
    case 'customer.subscription.deleted':
      return { type: 'plus_ended', subscription: o.id, userId: o.metadata?.user_id || '' };
    case 'customer.subscription.updated':
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(o.status)) {
        return { type: 'plus_ended', subscription: o.id, userId: o.metadata?.user_id || '' };
      }
      return { type: 'plus_renews', subscription: o.id, userId: o.metadata?.user_id || '', renews: !o.cancel_at_period_end && !o.cancel_at };
    case 'charge.refunded':
      // solo el reembolso completo deshace la compra (uno parcial es una decisión del dueño, se deja igual)
      return o.refunded ? { type: 'refunded', paymentRef: idOf(o.payment_intent) } : { type: 'ignored' };
    case 'charge.dispute.created':
      return { type: 'refunded', paymentRef: idOf(o.payment_intent) };
    default:
      return { type: 'ignored' };
  }
}

export function createPayments({ secretKey = '', webhookSecret = '', fetchImpl = fetch, log = console } = {}) {
  async function stripe(method, path, params) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params ? formEncode(params).toString() : undefined,
      });
    } catch (err) {
      log.warn('stripe sin conexión:', err.message);
      throw new AppError(502, 'payments', 'No pudimos conectar con el pago. Intenta de nuevo.', "Couldn't reach the payment provider. Try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.warn('stripe', res.status, data?.error?.message || '');
      if (res.status === 404) throw new AppError(404, 'not_found', 'Ese pago no existe', "That payment doesn't exist");
      throw new AppError(502, 'payments', 'El pago no se pudo iniciar. Intenta de nuevo.', "Couldn't start the payment. Try again.");
    }
    return data;
  }

  return {
    enabled: Boolean(secretKey),
    webhookReady: Boolean(secretKey && webhookSecret),
    testMode: secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_'),

    /** Página de pago de Stripe (redirección, no iframe: no hay que abrir la CSP). */
    async createCheckout({ userId, product, lifeNo, origin, lang }) {
      const p = PRODUCTS[product];
      if (!p) throw new AppError(400, 'product', 'Producto desconocido', 'Unknown product');
      const l = lang === 'es' ? 'es' : 'en';
      const meta = { user_id: userId, product, life_no: String(lifeNo) };
      const s = await stripe('POST', '/checkout/sessions', {
        mode: p.mode,
        client_reference_id: userId,
        metadata: meta,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: CURRENCY,
              unit_amount: p.price,
              product_data: { name: p.name[l], description: p.desc[l] },
              ...(p.mode === 'subscription' && { recurring: { interval: 'month' } }),
            },
          },
        ],
        ...(p.mode === 'subscription' ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
        allow_promotion_codes: 'true',
        locale: l,
        // Vuelve al mismo dominio del que salió: ahí está el reloj (cada dominio guarda sus relojes).
        success_url: `${origin}/?pago=ok&cs={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?pago=no`,
      });
      return { id: s.id, url: s.url };
    },

    /** Estado real de un checkout, preguntándole al proveedor (servidor a servidor, con la llave secreta). */
    async getSession(id) {
      if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(String(id))) throw new AppError(404, 'not_found', 'Ese pago no existe', "That payment doesn't exist");
      return sessionInfo(await stripe('GET', `/checkout/sessions/${encodeURIComponent(id)}`));
    },

    /** Que Plus no se renueve (sigue hasta el fin del mes pagado) o que vuelva a renovarse. */
    async setRenewal(subscription, renews) {
      await stripe('POST', `/subscriptions/${encodeURIComponent(subscription)}`, { cancel_at_period_end: renews ? 'false' : 'true' });
    },

    /** Verifica la firma y traduce el evento. Lanza 400 si la firma no es de Stripe. */
    parseWebhook(raw, signature) {
      verifySignature(raw, signature, webhookSecret);
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError(400, 'json', 'JSON inválido', 'Invalid JSON');
      }
      return { id: event.id, type: event.type, livemode: Boolean(event.livemode), action: eventAction(event) };
    },
  };
}
