// Ranking y juicios del jurado.
//
// Ranking: se entra por elección (Ajustes o la hoja del Ranking) y con nombre. Quien entra acepta que los demás
// vean su país, a qué se dedica, su liga, cuánto tiempo tiene y qué hace (sus actividades de 30 días). Dos tablas:
//   semana → tiempo neto ganado haciendo cosas en los últimos 7 días (sin transferencias, compras ni premios);
//   tiempo → lo que le queda en el reloj, sin contar lo comprado.
//
// Juicios (dura 2 días):
//   Día 1 · citación. Alguien con potestad cita a otro a juicio y los demás se pueden sumar. Todos ven cuánta
//     gente lo quiere llevar a juicio y LO QUE ESTÁ EN JUEGO: lo que ganó sin prueba en los 7 días antes.
//     La potestad se gana VIVIENDO de verdad, no ganando tiempo: con 15 días vividos vale 1, con 30 vale 2 y con
//     90 vale 3 (ACCUSE_POWER en economy.js). Hace falta sumar 3 (o 1 si ganó 2 semanas de vida en 7 días).
//     Ese mismo día el citado debe defenderse CON PRUEBAS (el movimiento del banco, una factura…), que revisa el
//     Guardián (si son contenido sexual: falta).
//   Al acabar el día 1: sin potestad suficiente, se archiva. Si se completó y no se defendió, es culpable.
//     Si se defendió, pasa al día 2.
//   Día 2 · veredicto secreto. Votan culpable o inocente los jugadores con 3 días vividos (nadie de su teléfono o
//     red, ni con quien se pasó tiempo; quienes lo citaron sí, para reconsiderar con las pruebas). Solo se ve
//     cuánta gente ha votado. Al acabar el día se revelan los votos: culpable con 2/3 y al menos 3 votos.
//   Culpable: pierde lo que estaba en juego (siempre le queda 1 h), que se reparte entre quienes votaron
//     culpable (o entre quienes lo citaron, si no se defendió); el Guardián deja de creerle sus ingresos y sale
//     del ranking 30 días.
//   Inocente: conserva lo que estaba en disputa y gana 1 día, igual que cada uno de los que votaron inocente.
//   Sin quórum: queda libre. Tras cualquier juicio, nadie puede volver a juzgarlo en 14 días.
// Cada persona vota (citar o decidir un veredicto) máximo una vez al día: contra el spam.

import { randomBytes } from 'node:crypto';
import { CATEGORIES, leagueOf, powerOf, ACCUSE_POWER } from '../public/economy.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export const TRIAL = {
  points: 3, // potestad que debe sumar la citación en el día 1
  suspiciousWeek: 14 * 86_400, // si ganó esto (s) en 7 días, basta 1 de potestad
  summonMs: DAY_MS, // día 1: citación y defensa
  voteMs: DAY_MS, // día 2: veredicto secreto
  quorum: 3,
  guiltyShare: 2 / 3,
  accuserLived: ACCUSE_POWER[0].days * 86_400, // tiempo vivido (s) para poder citar a juicio
  jurorLived: 3 * 86_400, // tiempo vivido (s) para votar un veredicto (contra cuentas creadas para eso)
  proofs: { min: 1, max: 3 }, // fotos de pruebas en la defensa
  immunityMs: 14 * DAY_MS,
  banMs: 30 * DAY_MS,
  keepMs: HOUR_MS, // una condena nunca deja a nadie en cero
  lookbackMs: WEEK_MS, // lo que está en juego: lo ganado sin prueba en los 7 días antes
  acquitReward: 86_400, // si sale inocente: 1 día para él y para cada uno de los que votaron inocente
};
export const REASONS = ['ingresos', 'imposible', 'cuentas', 'otro'];
export const BOARDS = ['semana', 'tiempo'];
const TOP = 100;

const keys = (pred) => Object.keys(CATEGORIES).filter((k) => pred(CATEGORIES[k]));
const list = (ks) => ks.map((k) => `'${k}'`).join(', ');
/** Lo que cuenta en el ranking semanal: actividades (con gastos), condenas y faltas. Nunca transferencias, compras ni premios. */
const RANK = list(keys((c) => !c.system || c.rank));
const BOUGHT = list(keys((c) => c.bought));
const ACTIVITY = list(keys((c) => !c.system));

/** Texto libre de la gente: sin controles ni marcas invisibles, una sola línea de espacios. */
const clean = (s, max) =>
  typeof s === 'string'
    ? s.normalize('NFC').replace(/[\p{Cc}\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

export function socialStore({ st, q, tx, must, now, snapshot, hooks, alertBand, AppError, livedSeconds, cleanImages, startOfLocalDay }) {
  const s = {
    rankRows: st(`
      SELECT u.id, u.public_id, u.nickname, u.bio, u.country, u.strikes, u.expires_at, u.plus_until, u.income_trust,
        (SELECT COALESCE(SUM(l.seconds), 0) FROM ledger l WHERE l.user_id = u.id AND l.at > ? AND l.category IN (${RANK})) AS week,
        (SELECT COALESCE(SUM(l.seconds), 0) FROM ledger l WHERE l.user_id = u.id AND l.life_no = u.life_no AND l.category IN (${BOUGHT})) AS bought,
        (SELECT tr.status FROM trials tr WHERE tr.user_id = u.id ORDER BY tr.id DESC LIMIT 1) AS last_trial
      FROM users u WHERE u.ranked = 1 AND u.expires_at > ?`),
    byPublic: st(`SELECT * FROM users WHERE public_id = ? AND public_id <> ''`),
    setRanked: st('UPDATE users SET ranked = ? WHERE id = ?'),
    setPublic: st('UPDATE users SET public_id = ? WHERE id = ?'),
    publicTaken: st('SELECT 1 AS x FROM users WHERE public_id = ?'),
    week: st(`SELECT COALESCE(SUM(seconds), 0) AS s FROM ledger WHERE user_id = ? AND at > ? AND category IN (${RANK})`),
    bought: st(`SELECT COALESCE(SUM(seconds), 0) AS s FROM ledger WHERE user_id = ? AND life_no = ? AND category IN (${BOUGHT})`),
    lifeSums: st('SELECT category, SUM(seconds) AS s FROM ledger WHERE user_id = ? AND life_no = ? GROUP BY category'),
    doing: st(`SELECT category, SUM(amount) AS amount, SUM(seconds) AS s, COUNT(*) AS n FROM ledger
               WHERE user_id = ? AND at > ? AND category IN (${ACTIVITY}) GROUP BY category`),
    recent: st(`SELECT at, seconds, note, category, amount, status FROM ledger
                WHERE user_id = ? AND at > ? AND category IN (${RANK}) ORDER BY id DESC LIMIT 25`),
    trialsOf: st('SELECT id, status, opened_at, closed_at, penalty FROM trials WHERE user_id = ? ORDER BY id DESC LIMIT 5'),
    lastTrial: st('SELECT status FROM trials WHERE user_id = ? ORDER BY id DESC LIMIT 1'),
    openOf: st(`SELECT * FROM trials WHERE user_id = ? AND status = 'abierto'`),
    lastClosed: st(`SELECT MAX(closed_at) AS at FROM trials WHERE user_id = ? AND status <> 'abierto'`),
    trial: st('SELECT * FROM trials WHERE id = ?'),
    trialInsert: st('INSERT INTO trials (user_id, opened_at, defense_until, vote_until, stake, needed) VALUES (?, ?, ?, ?, ?, ?)'),
    open: st(`SELECT * FROM trials WHERE status = 'abierto' ORDER BY id DESC`),
    closed: st(`SELECT * FROM trials WHERE status <> 'abierto' AND closed_at > ? ORDER BY closed_at DESC LIMIT 20`),
    dueDay1: st(`SELECT * FROM trials WHERE status = 'abierto' AND confirmed = 0 AND defense_until <= ?`),
    dueDay2: st(`SELECT * FROM trials WHERE status = 'abierto' AND confirmed = 1 AND vote_until <= ?`),
    confirm: st('UPDATE trials SET confirmed = 1 WHERE id = ?'),
    byGuardian: st('UPDATE trials SET by_guardian = ? WHERE id = ?'),
    defend: st('UPDATE trials SET defense = ?, defended_at = ?, evidence = ?, review = ? WHERE id = ?'),
    // al cerrar, las fotos de las pruebas se borran (eran solo para el jurado)
    close: st('UPDATE trials SET status = ?, closed_at = ?, guilty = ?, innocent = ?, penalty = ?, evidence = NULL WHERE id = ?'),
    accInsert: st('INSERT INTO accusations (target, accuser, reason, text, at, weight, trial_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    // potestad de la citación: por teléfono vale la mayor (varias cuentas de un celular cuentan como una)
    summonPoints: st(`SELECT COALESCE(NULLIF(u.device_id, ''), u.id) AS who, MAX(a.weight) AS w
                      FROM accusations a JOIN users u ON u.id = a.accuser WHERE a.trial_id = ? GROUP BY who`),
    summoners: st('SELECT DISTINCT accuser FROM accusations WHERE trial_id = ?'),
    recentGains: st(`SELECT note, category, amount, status FROM ledger
                     WHERE user_id = ? AND at > ? AND at <= ? AND seconds > 0 AND category IN (${ACTIVITY})
                     ORDER BY seconds DESC LIMIT 15`),
    accOfTrial: st('SELECT reason, text, at FROM accusations WHERE trial_id = ? ORDER BY at'),
    isAccuser: st('SELECT 1 AS x FROM accusations WHERE trial_id = ? AND accuser = ?'),
    // un voto al día por persona: citar o decidir un veredicto
    votesSince: st(`SELECT (SELECT COUNT(*) FROM accusations WHERE accuser = ?1 AND at >= ?2)
                         + (SELECT COUNT(*) FROM votes WHERE user_id = ?1 AND at >= ?2) AS n`),
    voteInsert: st('INSERT INTO votes (trial_id, user_id, vote, at) VALUES (?, ?, ?, ?)'),
    voteOf: st('SELECT vote FROM votes WHERE trial_id = ? AND user_id = ?'),
    voters: st('SELECT COUNT(*) AS n FROM votes WHERE trial_id = ?'),
    votersOf: st('SELECT user_id FROM votes WHERE trial_id = ? AND vote = ?'),
    tally: st(`SELECT COALESCE(SUM(vote = 'culpable'), 0) AS guilty, COALESCE(SUM(vote = 'inocente'), 0) AS innocent
               FROM votes WHERE trial_id = ?`),
    transferred: st(`SELECT 1 AS x FROM transfers WHERE status = 'entregado' AND done_at > ?
                     AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) LIMIT 1`),
    doubtful: st(`SELECT COALESCE(SUM(seconds), 0) AS s FROM ledger
                  WHERE user_id = ? AND life_no = ? AND at > ? AND at <= ? AND seconds > 0
                    AND status <> 'verificado' AND category IN (${ACTIVITY})`),
    convict: st('UPDATE users SET ranked = 0, income_trust = 0, banned_until = ? WHERE id = ?'),
  };

  const err = (status, code, es, en) => new AppError(status, code, es, en);

  /** Mismo teléfono, misma red o se pasaron tiempo en los últimos 30 días: no se juzgan entre sí. */
  function related(a, b, t) {
    if (a.device_id && a.device_id === b.device_id) return true;
    if (a.ip_hash && a.ip_hash === b.ip_hash) return true;
    return Boolean(s.transferred.get(t - 30 * DAY_MS, a.id, b.id, b.id, a.id));
  }

  /** citacion (día 1) · votacion (día 2) · cerrado. */
  const phaseOf = (tr) => (tr.status !== 'abierto' ? 'cerrado' : tr.confirmed ? 'votacion' : 'citacion');
  const deadline = (tr) => (phaseOf(tr) === 'citacion' ? tr.defense_until : tr.vote_until);
  /** ¿Ya usó su voto de hoy (en su hora)? */
  const votedToday = (u, t) => s.votesSince.get(u.id, startOfLocalDay(t, u.tz)).n > 0;
  const voteLimit = () => err(429, 'vote_limit', 'Ya votaste hoy: un voto por día. Mañana puedes volver a votar.', "You've already voted today: one vote a day. You can vote again tomorrow.");

  /** Lo que estaría en juego si lo citan ahora: lo que ganó sin prueba en los últimos 7 días (en esta vida). */
  const stakeOf = (v, t) => s.doubtful.get(v.id, v.life_no, t - TRIAL.lookbackMs, t).s;

  /** Potestad que lleva la citación (por teléfono) y cuánta gente la firmó. */
  function summons(tr) {
    const rows = s.summonPoints.all(tr.id);
    return { people: s.summoners.all(tr.id).length, points: rows.reduce((sum, r) => sum + r.w, 0) };
  }

  /** Tiempo que le queda sin contar lo comprado (con esto se ordena "Más tiempo" y se da la liga). */
  function earnedLeft(u, t) {
    const bought = s.bought.get(u.id, u.life_no).s;
    return Math.max(0, Math.floor((u.expires_at - t) / 1000) - bought);
  }

  /** Por qué no puede votar el veredicto (día 2) de este juicio (código), o null. Quienes lo citaron sí pueden. */
  function jurorProblem(u, tr, t) {
    if (u.id === tr.user_id) return 'own';
    if (!u.ranked) return 'not_ranked';
    if (u.expires_at <= t) return 'dead';
    if (livedSeconds(u, t) < TRIAL.jurorLived) return 'too_new';
    if (s.voteOf.get(tr.id, u.id)) return 'voted';
    const accused = q.byId.get(tr.user_id);
    if (accused && related(u, accused, t)) return 'related';
    if (phaseOf(tr) !== 'votacion' || t >= tr.vote_until) return 'phase';
    if (votedToday(u, t)) return 'vote_limit';
    return null;
  }

  /** Por qué no puede citar a juicio a esta persona, o sumarse a su citación (AppError), o null. */
  function summonProblem(u, v, t) {
    const tr = v && s.openOf.get(v.id);
    if (!v || (!v.ranked && !tr)) return err(404, 'target', 'Esa persona no está en el ranking', "That person isn't in the ranking");
    if (v.id === u.id) return err(409, 'own', 'No puedes citarte a juicio', "You can't put yourself on trial");
    if (!u.ranked) return err(403, 'not_ranked', 'Únete al ranking para citar a juicio y votar', 'Join the ranking to summon and vote');
    if (u.expires_at <= t) return err(409, 'dead', 'Tu tiempo se agotó', 'Your time ran out');
    const lived = livedSeconds(u, t);
    if (lived < TRIAL.accuserLived) {
      const days = Math.floor(lived / 86_400);
      const need = TRIAL.accuserLived / 86_400;
      return err(403, 'too_new', `Para citar a juicio necesitas ${need} días vividos de verdad (llevas ${days}).`, `To put someone on trial you need ${need} days really lived (you have ${days}).`);
    }
    if (related(u, v, t)) {
      return err(409, 'related', 'No puedes citar a alguien de tu teléfono o red, ni con quien te pasaste tiempo', "You can't summon someone on your phone or network, or someone you've exchanged time with");
    }
    if (tr) {
      if (phaseOf(tr) !== 'citacion' || t >= tr.defense_until) return err(409, 'on_trial', 'Ya está en juicio: vota el veredicto en Juicios', "They're already on trial: vote the verdict in Trials");
      if (s.isAccuser.get(tr.id, u.id)) return err(409, 'already', 'Ya lo citaste a este juicio', 'You already summoned them to this trial');
    } else {
      const last = s.lastClosed.get(v.id).at;
      if (last && t - last < TRIAL.immunityMs) {
        return err(409, 'immune', 'Tuvo un juicio hace poco: no se puede juzgar otra vez todavía', 'They had a trial recently: they cannot be tried again yet');
      }
      if (stakeOf(v, t) <= 0) {
        return err(409, 'nothing', 'No hay nada en juego: todo lo que ganó esta semana lo probó ante el Guardián', "There's nothing at stake: everything they earned this week was proven to the Guardian");
      }
    }
    if (votedToday(u, t)) return voteLimit();
    return null;
  }

  /** Lo que cualquiera del ranking puede ver de una persona: quién es, por qué vive tanto y qué hace. */
  function profileOf(v, t) {
    const sums = Object.fromEntries(s.lifeSums.all(v.id, v.life_no).map((r) => [r.category, r.s]));
    const sum = (...cats) => cats.reduce((acc, c) => acc + (sums[c] || 0), 0);
    const last = s.lastTrial.get(v.id)?.status;
    return {
      id: v.public_id,
      name: v.nickname,
      bio: v.bio,
      country: v.country,
      strikes: v.strikes,
      lifeNo: v.life_no,
      bornAt: v.born_at,
      remaining: Math.max(0, Math.floor((v.expires_at - t) / 1000)),
      earnedLeft: earnedLeft(v, t),
      league: leagueOf(earnedLeft(v, t)),
      week: s.week.get(v.id, t - WEEK_MS).s,
      plus: v.plus_until > t,
      verified: Boolean(v.income_trust),
      onTrial: last === 'abierto',
      absolved: last === 'inocente',
      ranked: Boolean(v.ranked),
      // "por qué vive tanto": de dónde salió el tiempo de esta vida
      why: {
        activities: sum('aprendizaje', 'salud', 'proyecto'),
        money: sum('ingreso', 'inversion'),
        received: sum('recibo'),
        bought: sum(...keys((c) => c.bought)),
        jury: sum('jurado'),
        spent: sum('consumo'),
        sent: sum('envio'),
        sentenced: sum('juicio', 'sancion'),
      },
      // qué hace: por categoría en los últimos 30 días, y lo último que contó
      doing: s.doing
        .all(v.id, t - 30 * DAY_MS)
        .map((r) => ({ category: r.category, amount: r.amount, seconds: r.s, n: r.n }))
        .sort((a, b) => Math.abs(b.seconds) - Math.abs(a.seconds)),
      recent: s.recent.all(v.id, t - 30 * DAY_MS).map((r) => ({ ...r })),
      trials: s.trialsOf.all(v.id).map((r) => ({ ...r })),
    };
  }

  function trialCard(tr, viewer, t) {
    const accused = q.byId.get(tr.user_id);
    const phase = phaseOf(tr);
    const reasons = {};
    for (const a of s.accOfTrial.all(tr.id)) reasons[a.reason] = (reasons[a.reason] || 0) + 1;
    const closed = phase === 'cerrado';
    const sp = phase === 'citacion' && accused ? summonProblem(viewer, accused, t) : null;
    const jp = phase === 'votacion' ? jurorProblem(viewer, tr, t) : null;
    return {
      id: tr.id,
      name: accused?.nickname || '',
      publicId: accused?.public_id || '',
      country: accused?.country || '',
      phase,
      until: closed ? tr.closed_at : deadline(tr),
      openedAt: tr.opened_at,
      stake: tr.stake, // lo que está en juego: público
      needed: tr.needed,
      byGuardian: tr.by_guardian || null, // lo citó el Guardián: su motivo (con eso basta para ir a juicio)
      summons: summons(tr), // día 1: público, por si lo que está en juego parece malo de verdad
      voters: s.voters.get(tr.id).n, // día 2: solo cuántos votaron, nunca qué
      reasons,
      mine: tr.user_id === viewer.id,
      defended: Boolean(tr.defended_at),
      summoned: Boolean(s.isAccuser.get(tr.id, viewer.id)),
      voted: Boolean(s.voteOf.get(tr.id, viewer.id)), // ni a uno mismo se le recuerda qué votó: es secreto
      canSummon: phase === 'citacion' && !sp,
      summonProblem: sp?.code || null,
      canVote: phase === 'votacion' && !jp,
      problem: jp,
      // al cerrar se revelan los votos (cuántos de cada lado; nunca quién votó qué)
      verdict: closed ? tr.status : null,
      guilty: closed ? tr.guilty : null,
      innocent: closed ? tr.innocent : null,
      penalty: closed ? tr.penalty : null,
    };
  }

  /** Suma tiempo (premio del jurado) a un reloj vivo. A uno en cero no se le da: no revive por un premio. */
  function reward(userId, seconds, note, t) {
    const u = q.byId.get(userId);
    if (!u || u.expires_at <= t || seconds <= 0) return 0;
    const expires = u.expires_at + seconds * 1000;
    q.addTx.run(u.id, u.life_no, t, seconds, note, 'jurado', seconds, 'premio');
    q.setExpiry.run(expires, alertBand(expires - t), u.id);
    return seconds;
  }

  /**
   * Culpable: pierde lo que estaba en juego (nunca menos de 1 h en el reloj), que se reparte por partes
   * iguales entre quienes ganaron (votaron culpable, o lo citaron si no se defendió). Sale del ranking 30 días.
   */
  function convict(tr, winners, t, out) {
    const u = q.byId.get(tr.user_id);
    let penalty = 0;
    if (u && u.expires_at > t) {
      penalty = Math.max(0, Math.min(tr.stake, Math.floor((u.expires_at - t - TRIAL.keepMs) / 1000)));
      if (penalty > 0) {
        q.addTx.run(u.id, u.life_no, t, -penalty, `Juicio #${tr.id}`, 'juicio', penalty, 'condena');
        const expires = u.expires_at - penalty * 1000;
        q.setExpiry.run(expires, alertBand(expires - t), u.id);
      }
    }
    if (u) s.convict.run(t + TRIAL.banMs, u.id);
    const share = winners.length ? Math.floor(penalty / winners.length) : 0;
    for (const w of winners) {
      const got = reward(w, share, `Juicio #${tr.id}`, t);
      if (got) out.push({ userId: w, kind: 'reward', amount: got, trialId: tr.id });
    }
    return penalty;
  }

  function lang(userId) {
    return q.byId.get(userId)?.lang || 'en';
  }

  // Lo que la pantalla principal necesita saber: si estoy en juicio y en cuántos puedo actuar hoy.
  hooks.myTrial = (u) => {
    const tr = s.openOf.get(u.id);
    return tr ? { id: tr.id, phase: phaseOf(tr), until: deadline(tr), defended: Boolean(tr.defended_at) } : null;
  };
  hooks.juryCount = (u, t) => {
    if (!u.ranked || votedToday(u, t)) return 0;
    return s.open.all().filter((tr) => {
      const accused = q.byId.get(tr.user_id);
      return phaseOf(tr) === 'citacion' ? accused && !summonProblem(u, accused, t) : !jurorProblem(u, tr, t);
    }).length;
  };

  /**
   * El Guardián cita a juicio a alguien del ranking cuando, juzgando su día, ve algo serio. Con eso basta: el
   * juicio arranca confirmado (debe defenderse con pruebas el día 1) y la gente se puede sumar a la citación.
   * No cita a quien no está en el ranking (no aceptó que lo vean), ni si ya hay juicio, es inmune o no hay nada en juego.
   */
  hooks.guardianSummon = (u, reason, t) => {
    if (!u.ranked || s.openOf.get(u.id)) return null;
    const last = s.lastClosed.get(u.id).at;
    if (last && t - last < TRIAL.immunityMs) return null;
    const stake = stakeOf(u, t);
    if (stake <= 0) return null;
    const r = s.trialInsert.run(u.id, t, t + TRIAL.summonMs, t + TRIAL.summonMs + TRIAL.voteMs, stake, 0);
    const id = Number(r.lastInsertRowid);
    s.byGuardian.run(reason || 'El Guardián vio algo que no cuadra', id);
    return id;
  };

  function newPublicId() {
    let id;
    do id = randomBytes(6).toString('base64url');
    while (s.publicTaken.get(id));
    return id;
  }

  return {
    /** Entrar o salir del ranking. Para entrar hace falta un nombre y no estar castigado por un jurado. */
    setRanked(id, on) {
      const u = must(id);
      const t = now();
      if (on) {
        if (!u.nickname) throw err(400, 'needs_name', 'Ponte un nombre o apodo para aparecer en el ranking', 'Set a name or nickname to appear in the ranking');
        if (u.banned_until > t) {
          const days = Math.ceil((u.banned_until - t) / DAY_MS);
          throw err(403, 'banned', `Un jurado te sacó del ranking: podrás volver en ${days} días`, `A jury removed you from the ranking: you can return in ${days} days`);
        }
        if (!u.public_id) s.setPublic.run(newPublicId(), id);
      }
      s.setRanked.run(on ? 1 : 0, id);
      return { state: snapshot(must(id)) };
    },

    /** La tabla: 'semana' (lo ganado haciendo cosas en 7 días) o 'tiempo' (lo que le queda, sin lo comprado). */
    ranking(id, board) {
      if (!BOARDS.includes(board)) throw err(400, 'board', 'Tabla desconocida', 'Unknown board');
      const me = must(id);
      const t = now();
      const rows = s.rankRows
        .all(t - WEEK_MS, t)
        .map((r) => {
          const left = Math.max(0, Math.floor((r.expires_at - t) / 1000) - r.bought);
          return {
            id: r.public_id,
            name: r.nickname,
            bio: r.bio,
            country: r.country,
            strikes: r.strikes,
            league: leagueOf(left),
            score: board === 'semana' ? r.week : left,
            week: r.week,
            left,
            plus: r.plus_until > t,
            verified: Boolean(r.income_trust),
            onTrial: r.last_trial === 'abierto',
            absolved: r.last_trial === 'inocente',
            you: r.id === me.id,
          };
        })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      rows.forEach((r, i) => (r.pos = i + 1));
      return { board, rows: rows.slice(0, TOP), me: rows.find((r) => r.you) || null, total: rows.length };
    },

    /** Perfil público de alguien del ranking (o en juicio), lo que estaría en juego y si quien mira puede citarlo. */
    profile(id, publicId) {
      const viewer = must(id);
      const t = now();
      const v = s.byPublic.get(String(publicId || ''));
      if (!v || (!v.ranked && !s.openOf.get(v.id) && v.id !== viewer.id)) {
        throw err(404, 'target', 'Esa persona no está en el ranking', "That person isn't in the ranking");
      }
      const problem = summonProblem(viewer, v, t);
      const lived = livedSeconds(viewer, t);
      const tr = s.openOf.get(v.id);
      return {
        ...profileOf(v, t),
        you: v.id === viewer.id,
        stake: tr ? tr.stake : stakeOf(v, t),
        trial: tr ? { id: tr.id, phase: phaseOf(tr), ...summons(tr), needed: tr.needed } : null,
        canAccuse: !problem,
        accuseProblem: problem?.code || null,
        myLived: lived,
        myPower: powerOf(lived),
      };
    },

    /** ¿Puede citar (o sumarse a la citación)? Lanza el motivo si no; si sí, devuelve el texto limpio. Antes de la IA. */
    accuseCheck(id, { target, reason, text } = {}) {
      if (!REASONS.includes(reason)) throw err(400, 'reason', 'Elige un motivo', 'Pick a reason');
      text = clean(text, 280);
      if (reason === 'otro' && !text) throw err(400, 'text', 'Cuenta por qué', 'Say why');
      const problem = summonProblem(must(id), s.byPublic.get(String(target || '')), now());
      if (problem) throw problem;
      return { text };
    },

    /**
     * Citar a juicio (día 1). Si nadie lo había citado, abre el juicio con lo que está en juego; si ya está en
     * citación, suma esta potestad. Cuenta como el voto del día. Devuelve cómo va la citación.
     */
    accuse(id, { target, reason, text } = {}) {
      ({ text } = this.accuseCheck(id, { target, reason, text }));
      return tx(() => {
        const u = must(id);
        const t = now();
        const v = s.byPublic.get(String(target || ''));
        const problem = summonProblem(u, v, t);
        if (problem) throw problem;
        let tr = s.openOf.get(v.id);
        const opened = !tr;
        if (opened) {
          const needed = s.week.get(v.id, t - WEEK_MS).s >= TRIAL.suspiciousWeek ? 1 : TRIAL.points;
          const r = s.trialInsert.run(v.id, t, t + TRIAL.summonMs, t + TRIAL.summonMs + TRIAL.voteMs, stakeOf(v, t), needed);
          tr = s.trial.get(Number(r.lastInsertRowid));
        }
        const weight = powerOf(livedSeconds(u, t));
        s.accInsert.run(v.id, u.id, reason, text, t, weight, tr.id);
        const { people, points } = summons(tr);
        return {
          opened,
          trialId: tr.id,
          people,
          count: points,
          needed: tr.needed,
          weight,
          stake: tr.stake,
          ...(opened && { notify: { userId: v.id, lang: v.lang || 'en' } }),
        };
      });
    },

    /** Juicios abiertos y los cerrados de los últimos 30 días. */
    trials(id) {
      const viewer = must(id);
      const t = now();
      return {
        open: s.open.all().map((tr) => trialCard(tr, viewer, t)),
        closed: s.closed.all(t - 30 * DAY_MS).map((tr) => trialCard(tr, viewer, t)),
      };
    },

    /** Un juicio con lo que el jurado necesita: acusaciones (anónimas), defensa, pruebas y el perfil del acusado. */
    trial(id, trialId) {
      const viewer = must(id);
      const t = now();
      const tr = s.trial.get(trialId);
      if (!tr) throw err(404, 'not_found', 'Ese juicio no existe', "That trial doesn't exist");
      const accused = q.byId.get(tr.user_id);
      const card = trialCard(tr, viewer, t);
      const evidence = tr.evidence ? JSON.parse(tr.evidence) : [];
      // las fotos: el acusado, y el día 2 quien puede votar o ya votó
      const seesProofs = card.mine || card.canVote || card.voted;
      return {
        ...card,
        accusations: s.accOfTrial.all(tr.id).map((a) => ({ reason: a.reason, text: a.text, at: a.at })),
        defense: tr.defense,
        review: tr.review ? JSON.parse(tr.review) : null,
        proofCount: evidence.length,
        proofs: seesProofs ? evidence.map((im) => ({ media_type: im.media_type, data: im.data })) : null,
        profile: accused ? profileOf(accused, t) : null,
        rules: { quorum: TRIAL.quorum, guiltyShare: TRIAL.guiltyShare, reward: TRIAL.acquitReward },
      };
    },

    /**
     * ¿Puede defenderse ya? Solo el día 1 y una vez. Valida texto y pruebas (1 a 3 fotos) y devuelve lo que el
     * Guardián necesita para revisarlas: las acusaciones y lo que ganó la semana antes del juicio.
     */
    defenseCheck(id, trialId, { text, images } = {}) {
      text = clean(text, 600);
      if (!text) throw err(400, 'text', 'Escribe tu defensa', 'Write your defense');
      const imgs = cleanImages(images, 0);
      if (imgs.length < TRIAL.proofs.min || imgs.length > TRIAL.proofs.max) {
        throw err(
          400,
          'proofs',
          `Tu defensa necesita pruebas: sube de ${TRIAL.proofs.min} a ${TRIAL.proofs.max} fotos (el movimiento del banco, una factura, un comprobante).`,
          `Your defense needs proof: upload ${TRIAL.proofs.min} to ${TRIAL.proofs.max} photos (a bank statement, an invoice, a receipt).`,
        );
      }
      const tr = s.trial.get(trialId);
      const t = now();
      if (!tr || tr.user_id !== id) throw err(404, 'not_found', 'Ese juicio no existe', "That trial doesn't exist");
      if (phaseOf(tr) !== 'citacion' || t >= tr.defense_until || tr.defended_at) {
        throw err(409, 'phase', 'Ya pasó el momento de defenderte', 'The time to defend yourself has passed');
      }
      const u = must(id);
      return {
        text,
        images: imgs,
        context: {
          accusations: s.accOfTrial.all(tr.id).map((a) => ({ reason: a.reason, text: a.text })),
          gains: s.recentGains.all(u.id, tr.opened_at - TRIAL.lookbackMs, tr.opened_at).map((r) => ({ ...r })),
        },
      };
    },

    /** La defensa del acusado, con sus pruebas y lo que el Guardián leyó en ellas (el jurado lo verá el día 2). */
    defend(id, trialId, { text, images, review } = {}) {
      const checked = this.defenseCheck(id, trialId, { text, images });
      const r = review || {};
      const saved = {
        summary: String(r.summary || '').slice(0, 400),
        supports: ['si', 'parcial', 'no'].includes(r.supports) ? r.supports : 'no',
      };
      return tx(() => {
        const t = now();
        const evidence = checked.images.map(({ media_type, data }) => ({ media_type, data }));
        s.defend.run(checked.text, t, JSON.stringify(evidence), JSON.stringify(saved), trialId);
        return { trial: trialCard(s.trial.get(trialId), must(id), t), state: snapshot(must(id)) };
      });
    },

    /** El veredicto (día 2): 'culpable' o 'inocente'. Secreto hasta el final. Cuenta como el voto del día. */
    vote(id, trialId, vote) {
      if (vote !== 'culpable' && vote !== 'inocente') throw err(400, 'vote', 'Voto inválido', 'Invalid vote');
      return tx(() => {
        const u = must(id);
        const t = now();
        const tr = s.trial.get(trialId);
        if (!tr) throw err(404, 'not_found', 'Ese juicio no existe', "That trial doesn't exist");
        const problem = jurorProblem(u, tr, t);
        if (problem === 'vote_limit') throw voteLimit();
        if (problem) {
          const text = {
            own: ['No puedes votar en tu propio juicio', "You can't vote in your own trial"],
            not_ranked: ['Únete al ranking para votar', 'Join the ranking to vote'],
            dead: ['Tu tiempo se agotó', 'Your time ran out'],
            too_new: ['Necesitas 3 días vividos para votar un veredicto', 'You need 3 days lived to vote a verdict'],
            voted: ['Ya votaste en este juicio', 'You already voted in this trial'],
            related: ['Estás relacionado con el acusado: no puedes votar', "You're related to the accused: you can't vote"],
            phase: ['Este juicio no está en votación', "This trial isn't open for voting"],
          }[problem];
          throw err(409, problem, ...text);
        }
        s.voteInsert.run(tr.id, u.id, vote, t);
        return { trial: trialCard(tr, u, t), state: snapshot(u) };
      });
    },

    /**
     * El mantenimiento: cierra el día 1 (archiva, condena si no se defendió, o pasa a votación) y el día 2
     * (revela los votos, sentencia y reparte). Devuelve a quién avisar y de qué.
     */
    closeTrials(t = now()) {
      return tx(() => {
        const out = [];
        for (const tr of s.dueDay1.all(t)) {
          const { people, points } = summons(tr);
          if (points < tr.needed) {
            s.close.run('archivado', t, 0, 0, 0, tr.id);
            out.push({ userId: tr.user_id, kind: 'archivado', trialId: tr.id });
          } else if (!tr.defended_at) {
            // se completó la citación y no se defendió con pruebas: culpable; lo en juego, para quienes lo citaron
            const winners = s.summoners.all(tr.id).map((r) => r.accuser);
            const penalty = convict(tr, winners, t, out);
            s.close.run('culpable', t, people, 0, penalty, tr.id);
            out.push({ userId: tr.user_id, kind: 'culpable', trialId: tr.id, amount: penalty });
          } else {
            s.confirm.run(tr.id);
            out.push({ userId: tr.user_id, kind: 'votacion', trialId: tr.id });
            for (const r of s.summoners.all(tr.id)) out.push({ userId: r.accuser, kind: 'reconsider', trialId: tr.id });
          }
        }
        for (const tr of s.dueDay2.all(t)) {
          const { guilty, innocent } = s.tally.get(tr.id);
          const total = guilty + innocent;
          const verdict = total < TRIAL.quorum ? 'sin_quorum' : guilty >= total * TRIAL.guiltyShare ? 'culpable' : 'inocente';
          let penalty = 0;
          if (verdict === 'culpable') {
            penalty = convict(tr, s.votersOf.all(tr.id, 'culpable').map((r) => r.user_id), t, out);
          } else if (verdict === 'inocente') {
            // conserva lo que estaba en disputa y gana 1 día, igual que cada uno de los que votaron inocente
            reward(tr.user_id, TRIAL.acquitReward, `Absuelto #${tr.id}`, t);
            for (const r of s.votersOf.all(tr.id, 'inocente')) {
              const got = reward(r.user_id, TRIAL.acquitReward, `Juicio #${tr.id}`, t);
              if (got) out.push({ userId: r.user_id, kind: 'reward', amount: got, trialId: tr.id });
            }
          }
          s.close.run(verdict, t, guilty, innocent, penalty, tr.id);
          out.push({ userId: tr.user_id, kind: verdict, trialId: tr.id, amount: verdict === 'inocente' ? TRIAL.acquitReward : penalty });
        }
        for (const o of out) o.lang = lang(o.userId);
        return out;
      });
    },
  };
}
