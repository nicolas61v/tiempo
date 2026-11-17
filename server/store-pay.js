// Compras: Tiempo Plus, Revivir, +4 días para ti y regalos de tiempo.
//
// El tiempo y el Plus se acreditan SOLO con un pago confirmado por el proveedor (webhook con firma verificada
// o consulta directa del servidor al proveedor), nunca por lo que diga el navegador. Todo es idempotente por
// la referencia del pago: un aviso repetido no acredita dos veces.
//
// Lo comprado nunca cuenta en el ranking (categorías con bought: true en economy.js) y tiene topes:
// +4 días para ti máximo una vez por semana y nunca en tu última hora; cada persona recibe máximo un regalo
// comprado por semana.

const DAY = 86_400;
const DAY_MS = DAY * 1000;
/** Tiempo que da cada producto (Plus no da tiempo). */
export const PRODUCT_SECONDS = { dia: 4 * DAY, revivir: DAY, regalo: 7 * DAY };
export const PRODUCTS_LIST = ['plus', 'dia', 'regalo', 'revivir'];
export const DIA_EVERY_MS = 7 * DAY_MS;
export const GIFT_EVERY_MS = 7 * DAY_MS;
const CRITICAL_MS = 3_600_000; // en la última hora no se vende tiempo: esa es para ganarlo
const PLUS_FIRST_MS = 31 * DAY_MS; // primer mes, hasta que llegue la factura con la fecha exacta
const PLUS_GRACE_MS = 2 * DAY_MS; // margen por si el cobro de la renovación se demora

export function payStore({ st, q, tx, must, now, snapshot, hooks, freeCode, alertBand, AppError, isPlus, PLUS }) {
  const p = {
    byRef: st('SELECT * FROM purchases WHERE ref = ?'),
    byPayment: st(`SELECT * FROM purchases WHERE payment_ref = ? AND payment_ref <> '' AND status = 'pagado'`),
    insert: st(`INSERT INTO purchases (user_id, provider, ref, product, amount, currency, payment_ref, life_no, seconds, ledger_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setStatus: st('UPDATE purchases SET status = ? WHERE id = ?'),
    setRef: st('UPDATE purchases SET ref = ? WHERE id = ?'),
    lastOf: st(`SELECT MAX(created_at) AS at FROM purchases WHERE user_id = ? AND product = ? AND status = 'pagado'`),
    mine: st('SELECT id, product, amount, currency, status, created_at FROM purchases WHERE user_id = ? ORDER BY id DESC LIMIT 20'),
    giftInsert: st('INSERT INTO gifts (code, purchase_id, from_user, seconds, created_at) VALUES (?, ?, ?, ?, ?)'),
    giftsMine: st(`SELECT g.code, g.seconds, g.status, g.created_at, g.done_at, COALESCE(u.nickname, '') AS to_name
                   FROM gifts g LEFT JOIN users u ON u.id = g.to_user
                   WHERE g.from_user = ? ORDER BY g.created_at DESC LIMIT 20`),
    giftOfPurchase: st('SELECT * FROM gifts WHERE purchase_id = ?'),
    giftSet: st('UPDATE gifts SET status = ?, to_user = ?, done_at = ?, ledger_id = ? WHERE code = ?'),
    giftLastReceived: st(`SELECT MAX(done_at) AS at FROM gifts WHERE to_user = ? AND status = 'entregado'`),
    userBySub: st(`SELECT * FROM users WHERE plus_sub = ? AND plus_sub <> ''`),
    // Cualquier compra (pagada o reembolsada) por su transacción o su checkout (también "ck_…:tran_…").
    ownerOf: st(`SELECT user_id FROM purchases
                 WHERE payment_ref = ? OR ref = ? OR substr(ref, 1, length(?) + 1) = ? || ':' OR substr(ref, -length(?) - 1) = ':' || ?
                 ORDER BY id DESC LIMIT 1`),
    setPlus: st('UPDATE users SET plus_until = ?, plus_sub = ?, plus_renews = ? WHERE id = ?'),
    setRenews: st('UPDATE users SET plus_renews = ? WHERE id = ?'),
    setReviveAt: st('UPDATE users SET plus_revive_at = ? WHERE id = ?'),
  };

  const err = (status, code, es, en) => new AppError(status, code, es, en);

  /** Por qué no se puede comprar algo ahora, o null. Se revisa al abrir el pago (el webhook acredita igual). */
  function buyProblem(u, product, t) {
    const dead = u.expires_at <= t;
    switch (product) {
      case 'plus':
        return isPlus(u, t) ? err(409, 'plus_active', 'Ya tienes Plus', 'You already have Plus') : null;
      case 'revivir':
        return dead ? null : err(409, 'alive', 'Revivir es solo cuando tu reloj llega a cero', 'Revive is only for when your clock hits zero');
      case 'regalo':
        return null;
      case 'dia': {
        if (dead) return err(409, 'dead', 'Tu reloj está en cero: mejor revive o renace', 'Your clock is at zero: revive or be reborn');
        if (u.expires_at - t <= CRITICAL_MS) {
          return err(409, 'critical', 'En tu última hora no vendemos tiempo: esa es para ganarlo', "We don't sell time in your last hour: that one is for earning");
        }
        const last = p.lastOf.get(u.id, 'dia').at;
        if (last && t - last < DIA_EVERY_MS) {
          const e = err(409, 'dia_limit', 'Ya compraste tus días de esta semana', "You've already bought this week's days");
          e.until = last + DIA_EVERY_MS;
          return e;
        }
        return null;
      }
      default:
        return err(400, 'product', 'Producto desconocido', 'Unknown product');
    }
  }

  /** Suma tiempo comprado al reloj (si estaba en cero, revive: el día cuenta desde ahora). */
  function credit(u, t, category, seconds, note, status) {
    const expires = (u.expires_at <= t ? t : u.expires_at) + seconds * 1000;
    const r = q.addTx.run(u.id, u.life_no, t, seconds, note, category, seconds, status);
    q.setExpiry.run(expires, alertBand(expires - t), u.id);
    return Number(r.lastInsertRowid);
  }

  /** Descuenta tiempo por un reembolso, solo en la misma vida y si sigue vivo (nunca deja menos de cero). */
  function takeBack(userId, seconds, ledgerId, t) {
    const u = q.byId.get(userId);
    const row = ledgerId && q.ledgerRow.get(ledgerId);
    if (!u || !row || row.life_no !== u.life_no || u.expires_at <= t || !seconds) return 0;
    const expires = Math.max(t, u.expires_at - seconds * 1000);
    q.addTx.run(u.id, u.life_no, t, -seconds, '', 'reembolso', seconds, 'reembolsado');
    q.setExpiry.run(expires, alertBand(expires - t), u.id);
    return seconds;
  }

  function endPlusOf(u, t) {
    p.setPlus.run(Math.min(u.plus_until, t), u.plus_sub, 0, u.id);
  }

  const userOf = ({ subscription, userId }) => (subscription && p.userBySub.get(subscription)) || (userId && q.byId.get(userId)) || null;

  /** Regalo comprado: se reclama con el mismo flujo de las transferencias (código + QR). Lo llama claimTransfer. */
  hooks.claimGift = (u, code, t) => {
    const g = q.giftGet.get(code);
    if (!g) return null;
    if (g.status !== 'pendiente') return { error: err(404, 'code', 'Código inválido o ya usado', 'Invalid or already used code') };
    if (g.from_user === u.id) return { error: err(409, 'own', 'Ese regalo es tuyo: dáselo a alguien', "That gift is yours: give it to someone") };
    if (u.expires_at <= t) return { error: err(409, 'dead', 'Tu reloj está en cero: renace primero', 'Your clock is at zero: be reborn first') };
    const last = p.giftLastReceived.get(u.id).at;
    if (last && t - last < GIFT_EVERY_MS) {
      const days = Math.ceil((last + GIFT_EVERY_MS - t) / DAY_MS);
      return {
        error: err(
          409,
          'gift_limit',
          `Ya recibiste un regalo comprado esta semana. Guarda el código: podrás usarlo en ${days} ${days === 1 ? 'día' : 'días'}.`,
          `You already got a bought gift this week. Keep the code: you can use it in ${days} ${days === 1 ? 'day' : 'days'}.`,
        ),
      };
    }
    const from = q.byId.get(g.from_user);
    const fromName = from?.nickname || '';
    const r = q.addTx.run(u.id, u.life_no, t, g.seconds, `Regalo de ${fromName || 'alguien'}`, 'regalo', g.seconds, 'recibido');
    const expires = u.expires_at + g.seconds * 1000;
    q.setExpiry.run(expires, alertBand(expires - t), u.id);
    p.giftSet.run('entregado', u.id, t, Number(r.lastInsertRowid), code);
    return { seconds: g.seconds, fromUser: g.from_user, fromName, fromLang: from?.lang || 'en', toName: u.nickname, gift: true };
  };

  return {
    /** Lanza el error si no se puede comprar; si se puede, devuelve lo que necesita el proveedor. */
    checkBuy(id, product) {
      const u = must(id);
      const problem = buyProblem(u, product, now());
      if (problem) throw problem;
      return { lifeNo: u.life_no, lang: u.lang || 'en' };
    },

    /** La tienda de esta persona: qué puede comprar ahora, su Plus, sus compras y sus regalos. */
    storeInfo(id) {
      const u = must(id);
      const t = now();
      return {
        products: PRODUCTS_LIST.map((product) => {
          const problem = buyProblem(u, product, t);
          return { id: product, seconds: PRODUCT_SECONDS[product] || 0, ok: !problem, code: problem?.code || null, until: problem?.until || null };
        }),
        purchases: p.mine.all(id).map((r) => ({ ...r })),
        gifts: p.giftsMine.all(id).map((g) => ({
          code: g.code,
          seconds: g.seconds,
          status: g.status,
          createdAt: g.created_at,
          doneAt: g.done_at,
          toName: g.to_name,
        })),
        state: snapshot(u),
      };
    },

    /** Una compra de esta persona por la referencia del checkout (para la vuelta del pago). */
    purchaseOf(id, ref) {
      const row = p.byRef.get(String(ref || ''));
      if (!row) return null; // aún no llega (o no existe)
      if (row.user_id !== id) return false; // es de otra persona
      const gift = row.product === 'regalo' ? p.giftOfPurchase.get(row.id) : null;
      return { product: row.product, status: row.status, seconds: row.seconds, giftCode: gift?.code || null };
    },

    /**
     * Pago confirmado de una compra única o del primer mes de Plus. Idempotente por ref (el checkout).
     * Si el mismo checkout se paga otra vez (otro paymentRef), es otra compra y se acredita también.
     * Revivir con el reloj ya andando (renació gratis mientras pagaba) o +1 día con el reloj en cero:
     * se entrega igual el día pagado.
     */
    fulfill({ provider = 'creem', ref, userId, product, paymentRef = '', amount = 0, currency = '', subscription = '' }) {
      if (!ref || !PRODUCTS_LIST.includes(product)) return { ignored: true };
      return tx(() => {
        let dup = p.byRef.get(ref);
        if (dup && paymentRef && dup.payment_ref && dup.payment_ref !== paymentRef) {
          ref = `${ref}:${paymentRef}`;
          dup = p.byRef.get(ref);
        }
        if (dup) return { duplicate: true, product: dup.product, userId: dup.user_id };
        // El primer cobro de Plus pudo llegar antes como renovación (subscription.paid): esa misma compra queda
        // con la referencia del checkout (para la vuelta del pago) y no se cuenta dos veces.
        const prior = product === 'plus' && paymentRef ? p.byPayment.get(paymentRef) : null;
        if (prior && prior.product === 'plus' && prior.ref === paymentRef) {
          p.setRef.run(ref, prior.id);
          return { product, kind: 'plus', seconds: 0, giftCode: null, userId: prior.user_id };
        }
        const u = q.byId.get(userId);
        if (!u) return { unknown: true };
        const t = now();
        let seconds = 0;
        let ledgerId = null;
        let kind = product;
        if (product === 'dia' || product === 'revivir') {
          seconds = PRODUCT_SECONDS[product];
          kind = u.expires_at <= t ? 'revivir' : 'dia';
          ledgerId = credit(u, t, kind === 'revivir' ? 'revivir' : 'compra', seconds, '', 'comprado');
        } else if (product === 'regalo') {
          seconds = PRODUCT_SECONDS.regalo;
        } else if (product === 'plus') {
          p.setPlus.run(Math.max(u.plus_until, t + PLUS_FIRST_MS), subscription || u.plus_sub, 1, u.id);
        }
        const r = p.insert.run(u.id, provider, ref, product, amount || 0, currency || '', paymentRef || '', u.life_no, seconds, ledgerId, t);
        let giftCode = null;
        if (product === 'regalo') {
          giftCode = freeCode();
          p.giftInsert.run(giftCode, Number(r.lastInsertRowid), u.id, seconds, t);
        }
        return { product, kind, seconds, giftCode, userId: u.id };
      });
    },

    /** Factura de Plus pagada (primer mes o renovación): Plus hasta el fin del periodo + 2 días de margen. */
    renewPlus({ provider = 'creem', subscription, userId, ref, until, amount = 0, currency = '' }) {
      return tx(() => {
        const u = userOf({ subscription, userId });
        if (!u) return { unknown: true };
        const t = now();
        const end = Number.isFinite(until) && until > t ? until : t + PLUS_FIRST_MS;
        p.setPlus.run(Math.max(u.plus_until, end + PLUS_GRACE_MS), subscription || u.plus_sub, 1, u.id);
        // Cada cobro queda una vez: el primero ya quedó con el checkout (misma transacción) y un aviso repetido no
        // suma otro. La referencia del cobro es también su payment_ref, para que un reembolso lo encuentre.
        if (ref && !p.byRef.get(ref) && !p.byPayment.get(ref)) {
          p.insert.run(u.id, provider, ref, 'plus', amount, currency, ref, u.life_no, 0, null, t);
        }
        return { userId: u.id };
      });
    },

    /** La suscripción terminó (cancelada, impaga o reembolsada): Plus se acaba ya. */
    endPlus({ subscription, userId }) {
      const u = userOf({ subscription, userId });
      if (u) endPlusOf(u, now());
      return { userId: u?.id || null };
    },

    /** ¿Se renueva sola? (cambia al cancelar o retomar la renovación). */
    setPlusRenews({ subscription, userId, renews }) {
      const u = userOf({ subscription, userId });
      if (u) p.setRenews.run(renews ? 1 : 0, u.id);
      return { userId: u?.id || null };
    },

    /** La suscripción de Plus de esta persona (para cancelar o retomar la renovación). */
    plusSubOf(id) {
      const u = must(id);
      if (!isPlus(u, now()) || !u.plus_sub) throw err(409, 'no_plus', 'No tienes Plus activo', "You don't have Plus");
      return u.plus_sub;
    },

    /** Reembolso o contracargo: se descuenta lo acreditado y se cancela el Plus. Idempotente. */
    refund(paymentRef) {
      if (!paymentRef) return 0;
      return tx(() => {
        const t = now();
        const list = p.byPayment.all(paymentRef);
        for (const pu of list) {
          if (pu.product === 'plus') {
            const u = q.byId.get(pu.user_id);
            if (u) endPlusOf(u, t);
          } else if (pu.product === 'regalo') {
            const g = p.giftOfPurchase.get(pu.id);
            if (g?.status === 'pendiente') p.giftSet.run('anulado', null, t, null, g.code);
            else if (g?.status === 'entregado') takeBack(g.to_user, g.seconds, g.ledger_id, t);
          } else {
            takeBack(pu.user_id, pu.seconds, pu.ledger_id, t);
          }
          p.setStatus.run('reembolsado', pu.id);
        }
        return list.length;
      });
    },

    /**
     * De qué reloj es una compra, para /admin: quien perdió su llave escribe con su recibo de Creem y el dueño,
     * con la transacción (tran_…), la suscripción (sub_…) o el checkout (ck_…), le da una llave nueva al mismo reloj.
     */
    ownerOfPayment(rawRef) {
      const ref = String(rawRef || '').trim();
      if (!/^(tran|sub|ck)_[A-Za-z0-9]{6,64}$/.test(ref)) {
        throw err(400, 'ref', 'Escribe la transacción (tran_…), la suscripción (sub_…) o el checkout (ck_…) de Creem', 'Invalid reference');
      }
      const u = ref.startsWith('sub_') ? p.userBySub.get(ref) : null;
      const id = u?.id || p.ownerOf.get(ref, ref, ref, ref, ref, ref)?.user_id;
      if (!id || !q.byId.get(id)) throw err(404, 'not_found', 'Ninguna compra tiene esa referencia', 'No purchase has that reference');
      return id;
    },

    /** Revivir gratis, una vez cada 30 días, para quien tiene Plus. */
    reviveFree(id) {
      return tx(() => {
        const u = must(id);
        const t = now();
        if (u.expires_at > t) throw err(409, 'alive', 'Aún tienes tiempo', 'You still have time');
        if (!isPlus(u, t)) throw err(403, 'plus', 'Revivir gratis es parte de Plus', 'Free revive is part of Plus');
        if (u.plus_revive_at && t - u.plus_revive_at < PLUS.reviveEvery) {
          throw err(409, 'plus_revive', 'Ya usaste tu Revivir gratis de este mes', "You've already used this month's free revive");
        }
        credit(u, t, 'revivir', DAY, 'Plus', 'plus');
        p.setReviveAt.run(t, u.id);
        return { state: snapshot(must(id)) };
      });
    },
  };
}
