import webpush from 'web-push';

// Avisos en el idioma de la app de cada persona (por defecto inglés).
const MESSAGES = {
  es: {
    86400: { title: 'Menos de 24 horas', body: 'Tu reloj entró en su último día. Gana tiempo.' },
    3600: { title: 'Menos de una hora', body: 'El reloj no espera. Muévete.' },
    600: { title: 'Quedan 10 minutos', body: 'Último aviso antes de que se agote tu tiempo.' },
    0: { title: 'Tiempo agotado', body: 'Tu reloj llegó a cero. Puedes renacer.' },
  },
  en: {
    86400: { title: 'Less than 24 hours', body: 'Your clock is on its last day. Earn time.' },
    3600: { title: 'Less than an hour', body: "The clock doesn't wait. Move." },
    600: { title: '10 minutes left', body: 'Last warning before your time runs out.' },
    0: { title: "Time's up", body: 'Your clock hit zero. You can be reborn.' },
  },
};
export const alertFor = (band, lang) => (MESSAGES[lang] || MESSAGES.en)[band];

// Recordatorio de "Mi día", según la hora de la persona.
const REMINDERS = {
  es: [
    { until: 12, title: '¿Cómo va tu día?', body: 'Cuéntale al Guardián lo que llevas: lo bueno suma tiempo.' },
    { until: 18, title: '¿Qué has hecho hoy?', body: 'Cuéntale al Guardián antes de que se te olvide.' },
    { until: 24, title: 'Antes de que acabe el día', body: 'Cuéntale al Guardián qué hiciste. Lo que no le cuentas no suma.' },
  ],
  en: [
    { until: 12, title: "How's your day going?", body: "Tell the Guardian what you've done so far: the good stuff adds time." },
    { until: 18, title: 'What have you done today?', body: 'Tell the Guardian before you forget.' },
    { until: 24, title: 'Before the day ends', body: "Tell the Guardian what you did. What you don't tell it doesn't count." },
  ],
};
export const reminderFor = (hour, lang) => (REMINDERS[lang] || REMINDERS.en).find((r) => hour < r.until);

// Juicios: a quién se cita, cómo va cada día y lo que gana cada uno. {x} = tiempo.
const TRIALS = {
  es: {
    open: { title: 'Te citaron a juicio', body: 'Hoy decide la gente si vas a juicio. Defiéndete con pruebas antes de que acabe el día o serás culpable.' },
    guardian: { title: 'El Guardián te llevó a juicio', body: 'Defiéndete con pruebas antes de que acabe el día o serás culpable.' },
    archivado: { title: 'Citación archivada', body: 'No se juntó la potestad para llevarte a juicio. Quedas libre.' },
    votacion: { title: 'Tu juicio pasa a votación', body: 'Mañana se revela el veredicto. Los votos son secretos.' },
    reconsider: { title: 'Se defendió con pruebas', body: 'El juicio que pediste pasa a votación: mira las pruebas y decide hoy.' },
    culpable: { title: 'Culpable', body: 'Perdiste {x}: se reparte entre quienes votaron. Sales del ranking por 30 días.' },
    inocente: { title: 'Inocente', body: 'Conservas lo que estaba en disputa y ganas {x}. Nadie puede juzgarte en 14 días.' },
    sin_quorum: { title: 'Juicio cerrado', body: 'No votaron suficientes jugadores: quedas libre.' },
    reward: { title: 'El jurado decidió', body: 'Ganaste {x} por tu voto.' },
  },
  en: {
    open: { title: "You've been summoned to trial", body: "Today people decide if you go to trial. Defend yourself with proof before the day ends or you'll be guilty." },
    guardian: { title: 'The Guardian put you on trial', body: "Defend yourself with proof before the day ends or you'll be guilty." },
    archivado: { title: 'Summons dismissed', body: "There wasn't enough power to take you to trial. You're free." },
    votacion: { title: 'Your trial goes to a vote', body: 'The verdict is revealed tomorrow. Votes are secret.' },
    reconsider: { title: 'They defended themselves with proof', body: 'The trial you asked for goes to a vote: look at the proof and decide today.' },
    culpable: { title: 'Guilty', body: "You lost {x}: it's split among those who voted. You're out of the ranking for 30 days." },
    inocente: { title: 'Innocent', body: 'You keep what was in dispute and win {x}. Nobody can try you for 14 days.' },
    sin_quorum: { title: 'Trial closed', body: "Not enough players voted: you're free." },
    reward: { title: 'The jury decided', body: 'You won {x} for your vote.' },
  },
};
export function trialFor(kind, lang, x = '') {
  const m = (TRIALS[lang] || TRIALS.en)[kind] || (TRIALS[lang] || TRIALS.en).sin_quorum;
  return { title: m.title, body: m.body.replace('{x}', x) };
}

/** A quien regaló: su tiempo (o su regalo comprado) llegó. */
export function deliveredFor(lang, { name, dur, gift }) {
  if (lang === 'es') {
    return gift
      ? { title: 'Regalo entregado', body: `${name || 'Alguien'} recibió tu regalo de ${dur}.` }
      : { title: 'Tiempo entregado', body: `${name || 'Alguien'} recibió ${dur} de tu tiempo.` };
  }
  return gift
    ? { title: 'Gift delivered', body: `${name || 'Someone'} received your ${dur} gift.` }
    : { title: 'Time delivered', body: `${name || 'Someone'} received ${dur} of your time.` };
}

const SWEEP_MS = 15_000;

/**
 * Alertas push. Las llaves VAPID se generan una sola vez y quedan en la base,
 * así no hay nada que configurar. Un barrido cada 15 s revisa quién cruzó un umbral.
 */
export function createPush(store, { subject, publicKey, privateKey, log }) {
  let keys = publicKey && privateKey ? { publicKey, privateKey } : store.getMeta('vapid');
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    store.setMeta('vapid', keys);
    log.info('llaves VAPID generadas');
  }
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  async function sendToUser(userId, payload, { topic = 'tiempo', urgency = 'high', ttl = 6 * 3600 } = {}) {
    const body = JSON.stringify(payload);
    await Promise.all(
      store.subsFor(userId).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
            TTL: ttl,
            urgency,
            topic, // un aviso nuevo reemplaza al pendiente del mismo tema
          });
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) store.deleteSub(s.endpoint);
          else log.warn('push falló:', err.statusCode ?? err.message);
        }
      }),
    );
  }

  let running = false;
  async function sweep() {
    if (running) return;
    running = true;
    try {
      const due = store.claimAlerts(Date.now());
      await Promise.all(due.map((a) => sendToUser(a.userId, { ...alertFor(a.band, a.lang), band: a.band, expiresAt: a.expiresAt })));
      // Un recordatorio viejo no sirve: si el teléfono no lo recibe en 2 h, se descarta.
      const reminders = store.claimReminders(Date.now());
      await Promise.all(
        reminders.map((r) => {
          const { title, body } = reminderFor(r.hour, r.lang);
          return sendToUser(r.userId, { title, body, kind: 'remind' }, { topic: 'recordatorio', urgency: 'normal', ttl: 2 * 3600 });
        }),
      );
    } catch (err) {
      log.error('barrido de alertas:', err);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();

  return { publicKey: keys.publicKey, sweep, sendToUser, stop: () => clearInterval(timer) };
}
