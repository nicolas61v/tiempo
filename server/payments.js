// Pagos con Lemon Squeezy, sin dependencias: la API es JSON:API y la firma del webhook es un HMAC.
// Lemon Squeezy es el "comerciante registrado": cobra, maneja los impuestos de cada país y le paga al dueño
// (por banco o PayPal), así que sirve desde países donde Stripe no abre cuentas, como Colombia.
//
// Variables (en Railway → Variables, nunca en el repo ni por chat). Pasos en el README:
//   LEMONSQUEEZY_API_KEY          llave de la API (Settings → API)
//   LEMONSQUEEZY_WEBHOOK_SECRET   el "Signing secret" que inventaste al crear el webhook de
//                                 https://<tu-dominio>/api/lemonsqueezy/webhook
//   LEMONSQUEEZY_VARIANT_PLUS · _DIA · _REGALO · _REVIVIR   id de la variante de cada producto
//   LEMONSQUEEZY_STORE_ID         opcional: si la llave ve una sola tienda, se descubre sola
// Los productos se crean en el panel (la API de Lemon Squeezy no deja crearlos). Lo que cobra la app sale de
// PRODUCTS (custom_price); en el panel van los mismos precios, para que el link público de la tienda no venda
// más barato. Al arrancar, check() revisa todo y, si falta una variante, deja en los logs los ids que hay.
//
// Capa intercambiable: createCheckout / parseWebhook devuelven acciones propias de la app
// ('paid', 'renewed', 'plus_ended', 'plus_renews', 'refunded'), así otro proveedor podría reemplazar a este.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './store.js';

export const PROVIDER = 'lemonsqueezy';

/** Precios en centavos de dólar. Cambiarlos aquí cambia lo que cobra el próximo checkout (y luego en el panel). */
export const CURRENCY = 'usd';
export const PRODUCTS = {
  plus: {
    mode: 'subscription',
    price: 499,
    name: { es: 'Tiempo Plus (mensual)', en: 'Tiempo Plus (monthly)' },
    desc: {
      es: '15 charlas al día con el Guardián, 3 réplicas, el Guardián más fino y 1 Revivir gratis al mes.',
      en: '15 chats a day with the Guardian, 3 replies, the sharper Guardian and 1 free revive a month.',
    },
  },
  dia: {
    mode: 'payment',
    price: 299,
    name: { es: '+4 días de vida', en: '+4 days of life' },
    desc: { es: 'Máximo uno por semana. No cuenta en el ranking.', en: "Up to one a week. Doesn't count in the ranking." },
  },
  regalo: {
    mode: 'payment',
    price: 499,
    name: { es: 'Regalo: 1 semana de vida', en: 'Gift: 1 week of life' },
    desc: { es: 'Un código y un QR para regalarle una semana a quien quieras.', en: 'A code and a QR to give a week to anyone you want.' },
  },
  revivir: {
    mode: 'payment',
    price: 499,
    name: { es: 'Revivir', en: 'Revive' },
    desc: { es: 'Vuelves con 1 día y conservas tu vida, tu récord y tu historial.', en: 'Come back with 1 day and keep your life, record and history.' },
  },
};

const API = 'https://api.lemonsqueezy.com/v1';
const CHECKOUT_TTL_MS = 6 * 3_600_000; // un link de pago viejo no sirve: se abre otro desde la app
/** Referencia propia de cada checkout: viaja en los datos del pago y en la URL de vuelta. */
export const CHECKOUT_REF = /^ck_[a-f0-9]{32}$/;

const badSignature = () => new AppError(400, 'signature', 'Firma inválida', 'Invalid signature');

/** Verifica el encabezado X-Signature (HMAC-SHA256 en hex del cuerpo crudo). Lanza 400 si no cuadra. */
export function verifySignature(raw, header, secret) {
  const sig = String(header || '').trim();
  if (!secret || !/^[a-f0-9]{64}$/i.test(sig)) throw badSignature();
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), expected)) throw badSignature();
}

const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : NaN;
};

/** Qué producto de la app es una variante de Lemon Squeezy ('' si no es de las configuradas). */
const productOf = (variants, variantId) =>
  Object.keys(PRODUCTS).find((k) => variants[k] && String(variants[k]) === String(variantId ?? '')) || '';

/**
 * Traduce un evento de Lemon Squeezy a una acción de la app. `variants` = { plus, dia, regalo, revivir } (ids).
 * El producto sale de la variante pagada, no de los datos del checkout: el link público de la tienda deja
 * escribir cualquier dato extra, pero no cambiar qué variante (ni a qué precio) se pagó.
 */
export function eventAction(event, variants = {}) {
  const custom = event?.meta?.custom_data || {};
  const userId = String(custom.user_id || '');
  const id = String(event?.data?.id ?? '');
  const a = event?.data?.attributes || {};
  switch (event?.meta?.event_name) {
    case 'order_created': {
      if (a.status !== 'paid') return { type: 'pending' };
      const product = productOf(variants, a.first_order_item?.variant_id);
      if (!product || !id) return { type: 'ignored' };
      return {
        type: 'paid',
        ref: CHECKOUT_REF.test(custom.ref) ? custom.ref : `order_${id}`,
        userId,
        product,
        paymentRef: `order_${id}`,
        subscription: '', // llega aparte, con subscription_created
        amount: a.total_usd ?? 0,
        currency: 'usd',
      };
    }
    case 'order_refunded':
      // solo el reembolso completo deshace la compra (uno parcial es una decisión del dueño, se deja igual)
      return a.status === 'refunded' && id ? { type: 'refunded', paymentRef: `order_${id}` } : { type: 'ignored' };

    case 'subscription_created':
    case 'subscription_updated':
    case 'subscription_cancelled':
    case 'subscription_resumed':
    case 'subscription_expired':
    case 'subscription_paused':
    case 'subscription_unpaused': {
      if (!id || productOf(variants, a.variant_id) !== 'plus') return { type: 'ignored' };
      const sub = { subscription: id, userId };
      switch (a.status) {
        case 'active':
        case 'on_trial':
          // pagada hasta renews_at; al renovarse, renews_at avanza y llega otro subscription_updated
          return { type: 'renewed', ...sub, ref: '', until: ms(a.renews_at), first: true };
        case 'cancelled':
          return { type: 'plus_renews', ...sub, renews: false }; // sigue hasta lo ya pagado (ends_at)
        case 'past_due':
          return { type: 'ignored' }; // Lemon Squeezy reintenta el cobro; Plus dura lo pagado + 2 días de margen
        default: // paused · unpaid · expired
          return { type: 'plus_ended', ...sub };
      }
    }
    case 'subscription_payment_success':
    case 'subscription_payment_recovered':
      if (!id || !a.subscription_id) return { type: 'ignored' };
      return {
        type: 'renewed',
        subscription: String(a.subscription_id),
        userId,
        ref: `invoice_${id}`,
        until: NaN, // la factura no trae el fin del periodo: lo pone subscription_updated
        amount: a.total_usd ?? 0,
        currency: 'usd',
        first: a.billing_reason === 'initial', // el primer mes ya quedó con order_created
      };
    case 'subscription_payment_refunded':
      return a.status === 'refunded' && a.subscription_id
        ? { type: 'plus_ended', subscription: String(a.subscription_id), userId }
        : { type: 'ignored' };
    default:
      return { type: 'ignored' };
  }
}

export function createPayments({ apiKey = '', webhookSecret = '', storeId = '', variants = {}, fetchImpl = fetch, log = console, now = Date.now } = {}) {
  let store = String(storeId || '');
  let storeP = null;
  let testMode = false;
  const missing = [
    !apiKey && 'LEMONSQUEEZY_API_KEY',
    !webhookSecret && 'LEMONSQUEEZY_WEBHOOK_SECRET',
    ...Object.keys(PRODUCTS)
      .filter((k) => !variants[k])
      .map((k) => `LEMONSQUEEZY_VARIANT_${k.toUpperCase()}`),
  ].filter(Boolean);

  async function ls(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      log.warn('lemonsqueezy sin conexión:', err.message);
      throw new AppError(502, 'payments', 'No pudimos conectar con el pago. Intenta de nuevo.', "Couldn't reach the payment provider. Try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.warn('lemonsqueezy', method, path.split('?')[0], res.status, data?.errors?.[0]?.detail || '');
      if (res.status === 404) throw new AppError(404, 'not_found', 'Ese pago no existe', "That payment doesn't exist");
      throw new AppError(502, 'payments', 'El pago no se pudo iniciar. Intenta de nuevo.', "Couldn't start the payment. Try again.");
    }
    return data;
  }

  /** La tienda: la de LEMONSQUEEZY_STORE_ID o, si la llave ve una sola, esa. */
  function storeOf() {
    if (store) return Promise.resolve(store);
    storeP ||= ls('GET', '/stores')
      .then((r) => {
        const list = r?.data || [];
        if (list.length !== 1) {
          log.warn(`⚠ La llave de Lemon Squeezy ve ${list.length} tiendas: define LEMONSQUEEZY_STORE_ID (${list.map((s) => `${s.id} = ${s.attributes?.name}`).join(', ')}).`);
          throw new AppError(503, 'payments_off', 'Los pagos aún no están activos', "Payments aren't available yet");
        }
        return (store = String(list[0].id));
      })
      .catch((err) => {
        storeP = null; // se reintenta en el próximo pago
        throw err;
      });
    return storeP;
  }

  /** Los productos y variantes de la tienda, para copiar sus ids desde los logs. */
  async function variantList() {
    const s = await storeOf();
    const [prods, vars] = await Promise.all([
      ls('GET', `/products?filter[store_id]=${encodeURIComponent(s)}&page[size]=100`),
      ls('GET', '/variants?page[size]=100'),
    ]);
    const names = new Map((prods?.data || []).map((p) => [String(p.id), p.attributes?.name || '']));
    return (vars?.data || [])
      .filter((v) => names.has(String(v.attributes?.product_id)))
      .map((v) => {
        const x = v.attributes;
        const kind = x.is_subscription ? 'suscripción' : 'pago único';
        const price = Number.isFinite(x.price) ? ` · US$${(x.price / 100).toFixed(2)}` : '';
        return `${v.id} · ${names.get(String(x.product_id))} · ${x.name} · ${kind}${price}`;
      });
  }

  return {
    provider: PROVIDER,
    enabled: !missing.length,
    webhookReady: Boolean(webhookSecret),
    missing,
    get testMode() {
      return testMode;
    },

    /** Página de pago de Lemon Squeezy (redirección, no iframe: no hay que abrir la CSP). */
    async createCheckout({ userId, product, lifeNo, origin, lang }) {
      const p = PRODUCTS[product];
      if (!p || !variants[product]) throw new AppError(400, 'product', 'Producto desconocido', 'Unknown product');
      const l = lang === 'es' ? 'es' : 'en';
      const ref = `ck_${randomBytes(16).toString('hex')}`;
      const s = await ls('POST', '/checkouts', {
        data: {
          type: 'checkouts',
          attributes: {
            custom_price: p.price,
            product_options: {
              name: p.name[l],
              description: p.desc[l],
              // Vuelve al mismo dominio del que salió: ahí está el reloj (cada dominio guarda sus relojes).
              redirect_url: `${origin}/?pago=ok&ck=${ref}`,
            },
            checkout_options: { media: false, discount: true },
            checkout_data: { custom: { user_id: userId, product, life_no: String(lifeNo), ref } },
            expires_at: new Date(now() + CHECKOUT_TTL_MS).toISOString(),
          },
          relationships: {
            store: { data: { type: 'stores', id: await storeOf() } },
            variant: { data: { type: 'variants', id: String(variants[product]) } },
          },
        },
      });
      const out = s?.data?.attributes || {};
      if (!out.url) throw new AppError(502, 'payments', 'El pago no se pudo iniciar. Intenta de nuevo.', "Couldn't start the payment. Try again.");
      if (typeof out.test_mode === 'boolean') testMode = out.test_mode;
      return { ref, url: out.url };
    },

    /** Que Plus no se renueve (sigue hasta el fin del mes pagado) o que vuelva a renovarse. */
    async setRenewal(subscription, renews) {
      const path = `/subscriptions/${encodeURIComponent(subscription)}`;
      if (renews) await ls('PATCH', path, { data: { type: 'subscriptions', id: String(subscription), attributes: { cancelled: false } } });
      else await ls('DELETE', path);
    },

    /** Verifica la firma y traduce el evento. Lanza 400 si la firma no es de Lemon Squeezy. */
    parseWebhook(raw, signature) {
      verifySignature(raw, signature, webhookSecret);
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError(400, 'json', 'JSON inválido', 'Invalid JSON');
      }
      return {
        type: String(event?.meta?.event_name || ''),
        livemode: event?.meta?.test_mode === false,
        action: eventAction(event, variants),
      };
    },

    /**
     * Al arrancar: revisa la llave, la tienda y cada variante (que exista y que Plus sea la suscripción), y
     * deja en los logs lo que falte. Si falta o sobra una variante, lista las de la tienda con sus ids.
     */
    async check() {
      if (!apiKey) return [];
      const problems = [];
      try {
        await storeOf();
      } catch (err) {
        if (err.code !== 'payments_off') log.warn('⚠ Lemon Squeezy: no se pudo leer la tienda (¿la llave está bien copiada y es de la misma modalidad, prueba o real?).');
        return ['tienda'];
      }
      for (const [product, p] of Object.entries(PRODUCTS)) {
        const id = variants[product];
        if (!id) continue;
        let v;
        try {
          v = (await ls('GET', `/variants/${encodeURIComponent(id)}`))?.data?.attributes || {};
        } catch {
          problems.push(`la variante ${id} de ${product} no existe (¿es de la otra modalidad, prueba o real?)`);
          continue;
        }
        if (typeof v.test_mode === 'boolean') testMode = v.test_mode;
        const sub = p.mode === 'subscription';
        if (typeof v.is_subscription === 'boolean' && v.is_subscription !== sub) {
          problems.push(`la variante ${id} de ${product} ${sub ? 'debe ser una suscripción mensual' : 'debe ser de pago único'}`);
        }
        if (Number.isFinite(v.price) && v.price > 0 && v.price !== p.price) {
          problems.push(`la variante ${id} de ${product} cuesta US$${(v.price / 100).toFixed(2)} en el panel y la app cobra US$${(p.price / 100).toFixed(2)}: ponle el mismo precio`);
        }
      }
      for (const msg of problems) log.warn(`⚠ Lemon Squeezy: ${msg}.`);
      if (problems.length || missing.some((m) => m.includes('_VARIANT_'))) {
        try {
          const list = await variantList();
          log.info(`variantes de tu tienda (id · producto · variante · tipo):\n  ${list.join('\n  ') || '(ninguna: crea los productos en el panel)'}`);
        } catch {}
      }
      if (!missing.length && !problems.length) log.info(`pagos con Lemon Squeezy listos${testMode ? ' (modo de prueba)' : ' (modo real)'}`);
      return problems;
    },
  };
}
