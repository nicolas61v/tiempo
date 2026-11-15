// Ranking y juicios del jurado.
//
// Ranking: se entra por elección (Ajustes o la hoja del Ranking) y con nombre. Quien entra acepta que los demás
// vean su liga, cuánto tiempo tiene y qué hace (sus actividades de los últimos 30 días). Dos tablas:
//   semana → tiempo neto ganado haciendo cosas en los últimos 7 días (sin transferencias ni compras);
//   tiempo → lo que le queda en el reloj, sin contar lo comprado.
//
// Juicios: si alguien parece sospechosamente rico en tiempo, los demás del ranking pueden pedir un juicio.
// Con 3 acusadores distintos (o 1 si ganó 2 semanas de vida en 7 días) se abre: 24 h para defenderse,
// luego 48 h de votación de un jurado de jugadores (nadie de su teléfono o red, ni con quien se pasó tiempo,
// ni sus acusadores). Culpable con 2/3 de los votos y al menos 3 votos:
//   pierde lo ganado sin prueba en los 7 días antes del juicio (siempre le queda al menos 1 h),
//   el Guardián deja de creerle sus ingresos y sale del ranking 30 días.
// Sin quórum o inocente: queda absuelto y nadie puede volver a juzgarlo en 14 días.

import { randomBytes } from 'node:crypto';
import { CATEGORIES, leagueOf } from '../public/economy.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export const TRIAL = {
  accusers: 3, // acusadores distintos (por teléfono) en 7 días para abrir un juicio
  suspiciousWeek: 14 * 86_400, // si ganó esto (s) en 7 días, basta una acusación
  defenseMs: 24 * HOUR_MS,
  voteMs: 48 * HOUR_MS,
  quorum: 3,
  guiltyShare: 2 / 3,
  minAgeMs: 3 * DAY_MS, // relojes nuevos no acusan ni votan (contra cuentas creadas para eso)
  immunityMs: 14 * DAY_MS,
  banMs: 30 * DAY_MS,
  keepMs: HOUR_MS, // una condena nunca deja a nadie en cero
  lookbackMs: WEEK_MS, // lo que se revisa: lo ganado en los 7 días antes del juicio
  accusePerDay: 3,
};
export const REASONS = ['ingresos', 'imposible', 'cuentas', 'otro'];
export const BOARDS = ['semana', 'tiempo'];
const TOP = 100;

const keys = (pred) => Object.keys(CATEGORIES).filter((k) => pred(CATEGORIES[k]));
const list = (ks) => ks.map((k) => `'${k}'`).join(', ');
/** Lo que cuenta en el ranking semanal: actividades (con gastos) y condenas. Nunca transferencias ni compras. */
const RANK = list(keys((c) => !c.system || c.rank));
const BOUGHT = list(keys((c) => c.bought));
const ACTIVITY = list(keys((c) => !c.system));

/** Texto libre de la gente: sin controles ni marcas invisibles, una sola línea de espacios. */
const clean = (s, max) =>
  typeof s === 'string'
    ? s.normalize('NFC').replace(/[\p{Cc}\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

export function socialStore({ st, q, tx, must, now, snapshot, hooks, alertBand, AppError }) {
  const s = {
    rankRows: st(`
      SELECT u.id, u.public_id, u.nickname, u.expires_at, u.plus_until, u.income_trust,
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
    trialInsert: st('INSERT INTO trials (user_id, opened_at, defense_until, vote_until) VALUES (?, ?, ?, ?)'),
    open: st(`SELECT * FROM trials WHERE status = 'abierto' ORDER BY id DESC`),
    closed: st(`SELECT * FROM trials WHERE status <> 'abierto' AND closed_at > ? ORDER BY closed_at DESC LIMIT 20`),
    due: st(`SELECT * FROM trials WHERE status = 'abierto' AND vote_until <= ?`),
    defend: st('UPDATE trials SET defense = ?, defended_at = ?, vote_until = ? WHERE id = ?'),
    close: st('UPDATE trials SET status = ?, closed_at = ?, guilty = ?, innocent = ?, penalty = ? WHERE id = ?'),
    accInsert: st('INSERT INTO accusations (target, accuser, reason, text, at) VALUES (?, ?, ?, ?, ?)'),
    // acusadores distintos por teléfono: varias cuentas de un mismo celular cuentan como una
    accPending: st(`SELECT COUNT(DISTINCT COALESCE(NULLIF(u.device_id, ''), u.id)) AS n
                    FROM accusations a JOIN users u ON u.id = a.accuser
                    WHERE a.target = ? AND a.trial_id IS NULL AND a.at > ?`),
    accAssign: st('UPDATE accusations SET trial_id = ? WHERE target = ? AND trial_id IS NULL AND at > ?'),
    accOfTrial: st('SELECT reason, text, at FROM accusations WHERE trial_id = ? ORDER BY at'),
    isAccuser: st('SELECT 1 AS x FROM accusations WHERE trial_id = ? AND accuser = ?'),
    accByIn: st('SELECT COUNT(*) AS n FROM accusations WHERE accuser = ? AND at > ?'),
    accAlready: st('SELECT 1 AS x FROM accusations WHERE accuser = ? AND target = ? AND at > ?'),
    voteInsert: st('INSERT INTO votes (trial_id, user_id, vote, at) VALUES (?, ?, ?, ?)'),
    voteOf: st('SELECT vote FROM votes WHERE trial_id = ? AND user_id = ?'),
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

  const phaseOf = (tr, t) =>
    tr.status !== 'abierto' ? 'cerrado' : !tr.defended_at && t < tr.defense_until ? 'defensa' : 'votacion';
  const deadline = (tr, t) => (phaseOf(tr, t) === 'defensa' ? tr.defense_until : tr.vote_until);

  /** Tiempo que le queda sin contar lo comprado (con esto se ordena "Más tiempo" y se da la liga). */
  function earnedLeft(u, t) {
    const bought = s.bought.get(u.id, u.life_no).s;
    return Math.max(0, Math.floor((u.expires_at - t) / 1000) - bought);
  }

  /** Por qué no puede ser jurado de este juicio (código), o null. */
  function jurorProblem(u, tr, t) {
    if (u.id === tr.user_id) return 'own';
    if (!u.ranked) return 'not_ranked';
    if (u.expires_at <= t) return 'dead';
    if (t - u.created_at < TRIAL.minAgeMs) return 'too_new';
    if (s.voteOf.get(tr.id, u.id)) return 'voted';
    if (s.isAccuser.get(tr.id, u.id)) return 'accuser';
    const accused = q.byId.get(tr.user_id);
    if (accused && related(u, accused, t)) return 'related';
    if (phaseOf(tr, t) !== 'votacion' || t >= tr.vote_until) return 'phase';
    return null;
  }

  /** Por qué no puede pedir juicio para esta persona (AppError), o null. */
  function accuseProblem(u, v, t) {
    if (!v || (!v.ranked && !s.openOf.get(v.id))) return err(404, 'target', 'Esa persona no está en el ranking', "That person isn't in the ranking");
    if (v.id === u.id) return err(409, 'own', 'No puedes pedir un juicio contra ti', "You can't put yourself on trial");
    if (!u.ranked) return err(403, 'not_ranked', 'Únete al ranking para pedir juicios y votar', 'Join the ranking to request trials and vote');
    if (u.expires_at <= t) return err(409, 'dead', 'Tu tiempo se agotó', 'Your time ran out');
    if (t - u.created_at < TRIAL.minAgeMs) {
      return err(403, 'too_new', 'Tu reloj es muy nuevo: podrás pedir juicios desde su tercer día', 'Your clock is too new: you can request trials from its third day');
    }
    if (s.openOf.get(v.id)) return err(409, 'on_trial', 'Ya está en juicio: vota en Juicios', "They're already on trial: vote in Trials");
    const last = s.lastClosed.get(v.id).at;
    if (last && t - last < TRIAL.immunityMs) {
      return err(409, 'immune', 'Tuvo un juicio hace poco: no se puede juzgar otra vez todavía', 'They had a trial recently: they cannot be tried again yet');
    }
    if (related(u, v, t)) {
      return err(409, 'related', 'No puedes pedir juicio contra alguien de tu teléfono o red, ni con quien te pasaste tiempo', "You can't request a trial against someone on your phone or network, or someone you've exchanged time with");
    }
    if (s.accAlready.get(u.id, v.id, t - 30 * DAY_MS)) return err(409, 'already', 'Ya pediste juicio para esta persona', 'You already requested a trial for this person');
    if (s.accByIn.get(u.id, t - DAY_MS).n >= TRIAL.accusePerDay) {
      return err(429, 'rate', `Máximo ${TRIAL.accusePerDay} pedidos de juicio por día`, `Up to ${TRIAL.accusePerDay} trial requests per day`);
    }
    return null;
  }

  /** Lo que cualquiera del ranking puede ver de una persona: por qué vive tanto y qué hace. */
  function profileOf(v, t) {
    const sums = Object.fromEntries(s.lifeSums.all(v.id, v.life_no).map((r) => [r.category, r.s]));
    const sum = (...cats) => cats.reduce((acc, c) => acc + (sums[c] || 0), 0);
    const last = s.lastTrial.get(v.id)?.status;
    return {
      id: v.public_id,
      name: v.nickname,
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
        spent: sum('consumo'),
        sent: sum('envio'),
        sentenced: sum('juicio'),
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
    const phase = phaseOf(tr, t);
    const reasons = {};
    for (const a of s.accOfTrial.all(tr.id)) reasons[a.reason] = (reasons[a.reason] || 0) + 1;
    const closed = phase === 'cerrado';
    const problem = closed ? null : jurorProblem(viewer, tr, t);
    return {
      id: tr.id,
      name: accused?.nickname || '',
      publicId: accused?.public_id || '',
      phase,
      until: closed ? tr.closed_at : deadline(tr, t),
      openedAt: tr.opened_at,
      reasons,
      mine: tr.user_id === viewer.id,
      defended: Boolean(tr.defended_at),
      myVote: s.voteOf.get(tr.id, viewer.id)?.vote || null,
      canVote: !closed && !problem,
      problem,
      // los votos se ven solo al cerrar: así nadie vota por seguir a la mayoría
      verdict: closed ? tr.status : null,
      guilty: closed ? tr.guilty : null,
      innocent: closed ? tr.innocent : null,
      penalty: closed ? tr.penalty : null,
    };
  }

  // Lo que la pantalla principal necesita saber: si estoy en juicio y en cuántos puedo votar.
  hooks.myTrial = (u, t) => {
    const tr = s.openOf.get(u.id);
    return tr ? { id: tr.id, phase: phaseOf(tr, t), until: deadline(tr, t), defended: Boolean(tr.defended_at) } : null;
  };
  hooks.juryCount = (u, t) => (u.ranked ? s.open.all().filter((tr) => !jurorProblem(u, tr, t)).length : 0);

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

    /** Perfil público de alguien del ranking (o en juicio), y si quien mira puede pedirle un juicio. */
    profile(id, publicId) {
      const viewer = must(id);
      const t = now();
      const v = s.byPublic.get(String(publicId || ''));
      if (!v || (!v.ranked && !s.openOf.get(v.id) && v.id !== viewer.id)) {
        throw err(404, 'target', 'Esa persona no está en el ranking', "That person isn't in the ranking");
      }
      const problem = accuseProblem(viewer, v, t);
      return { ...profileOf(v, t), you: v.id === viewer.id, canAccuse: !problem, accuseProblem: problem?.code || null };
    },

    /** Pedir un juicio. Devuelve si se abrió y, si no, cuántos acusadores faltan. */
    accuse(id, { target, reason, text } = {}) {
      if (!REASONS.includes(reason)) throw err(400, 'reason', 'Elige un motivo', 'Pick a reason');
      text = clean(text, 280);
      if (reason === 'otro' && !text) throw err(400, 'text', 'Cuenta por qué', 'Say why');
      return tx(() => {
        const u = must(id);
        const t = now();
        const v = s.byPublic.get(String(target || ''));
        const problem = accuseProblem(u, v, t);
        if (problem) throw problem;
        s.accInsert.run(v.id, u.id, reason, text, t);
        const needed = s.week.get(v.id, t - WEEK_MS).s >= TRIAL.suspiciousWeek ? 1 : TRIAL.accusers;
        const count = s.accPending.get(v.id, t - WEEK_MS).n;
        if (count < needed) return { opened: false, count, needed };
        const r = s.trialInsert.run(v.id, t, t + TRIAL.defenseMs, t + TRIAL.defenseMs + TRIAL.voteMs);
        const trialId = Number(r.lastInsertRowid);
        s.accAssign.run(trialId, v.id, t - WEEK_MS);
        return { opened: true, trialId, count, needed, notify: { userId: v.id, lang: v.lang || 'en' } };
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

    /** Un juicio con todo lo que el jurado necesita: acusaciones (anónimas), defensa y el perfil del acusado. */
    trial(id, trialId) {
      const viewer = must(id);
      const t = now();
      const tr = s.trial.get(trialId);
      if (!tr) throw err(404, 'not_found', 'Ese juicio no existe', "That trial doesn't exist");
      const accused = q.byId.get(tr.user_id);
      return {
        ...trialCard(tr, viewer, t),
        accusations: s.accOfTrial.all(tr.id).map((a) => ({ reason: a.reason, text: a.text, at: a.at })),
        defense: tr.defense,
        profile: accused ? profileOf(accused, t) : null,
        rules: { quorum: TRIAL.quorum, guiltyShare: TRIAL.guiltyShare },
      };
    },

    /** La defensa del acusado: una vez y dentro de sus 24 h. Al defenderse empieza la votación. */
    defend(id, trialId, text) {
      text = clean(text, 600);
      if (!text) throw err(400, 'text', 'Escribe tu defensa', 'Write your defense');
      return tx(() => {
        const tr = s.trial.get(trialId);
        const t = now();
        if (!tr || tr.user_id !== id) throw err(404, 'not_found', 'Ese juicio no existe', "That trial doesn't exist");
        if (phaseOf(tr, t) !== 'defensa') throw err(409, 'phase', 'Ya pasó el momento de defenderte', 'The time to defend yourself has passed');
        s.defend.run(text, t, t + TRIAL.voteMs, tr.id);
        return { trial: trialCard(s.trial.get(tr.id), must(id), t), state: snapshot(must(id)) };
      });
    },

    /** Un voto por jurado y por juicio: 'culpable' o 'inocente'. */
    vote(id, trialId, vote) {
      if (vote !== 'culpable' && vote !== 'inocente') throw err(400, 'vote', 'Voto inválido', 'Invalid vote');
      return tx(() => {
        const u = must(id);
        const t = now();
        const tr = s.trial.get(trialId);
        if (!tr) throw err(404, 'not_found', 'Ese juicio no existe', "That trial doesn't exist");
        const problem = jurorProblem(u, tr, t);
        if (problem) {
          const text = {
            own: ['No puedes votar en tu propio juicio', "You can't vote in your own trial"],
            not_ranked: ['Únete al ranking para ser jurado', 'Join the ranking to be a juror'],
            dead: ['Tu tiempo se agotó', 'Your time ran out'],
            too_new: ['Tu reloj es muy nuevo para ser jurado', 'Your clock is too new to be a juror'],
            voted: ['Ya votaste en este juicio', 'You already voted in this trial'],
            accuser: ['Pediste este juicio: no puedes ser jurado', 'You requested this trial: you cannot be a juror'],
            related: ['Estás relacionado con el acusado: no puedes ser jurado', "You're related to the accused: you cannot be a juror"],
            phase: ['Este juicio no está en votación', "This trial isn't open for voting"],
          }[problem];
          throw err(409, problem, ...text);
        }
        s.voteInsert.run(tr.id, u.id, vote, t);
        return { trial: trialCard(tr, u, t), state: snapshot(u) };
      });
    },

    /** Cierra los juicios vencidos y aplica la sentencia. Devuelve a quién avisar. */
    closeTrials(t = now()) {
      return tx(() => {
        const out = [];
        for (const tr of s.due.all(t)) {
          const { guilty, innocent } = s.tally.get(tr.id);
          const total = guilty + innocent;
          const verdict = total < TRIAL.quorum ? 'sin_quorum' : guilty >= total * TRIAL.guiltyShare ? 'culpable' : 'inocente';
          const u = q.byId.get(tr.user_id);
          let penalty = 0;
          if (verdict === 'culpable' && u) {
            if (u.expires_at > t) {
              const doubt = s.doubtful.get(u.id, u.life_no, tr.opened_at - TRIAL.lookbackMs, tr.opened_at).s;
              penalty = Math.max(0, Math.min(doubt, Math.floor((u.expires_at - t - TRIAL.keepMs) / 1000)));
              if (penalty > 0) {
                q.addTx.run(u.id, u.life_no, t, -penalty, `Juicio #${tr.id}`, 'juicio', penalty, 'condena');
                const expires = u.expires_at - penalty * 1000;
                q.setExpiry.run(expires, alertBand(expires - t), u.id);
              }
            }
            s.convict.run(t + TRIAL.banMs, u.id);
          }
          s.close.run(verdict, t, guilty, innocent, penalty, tr.id);
          if (u) out.push({ userId: u.id, lang: u.lang || 'en', verdict, penalty, trialId: tr.id });
        }
        return out;
      });
    },
  };
}
