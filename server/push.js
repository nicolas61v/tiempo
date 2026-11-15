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

// Juicios del jurado: al abrirse (al acusado) y al cerrarse (el veredicto).
const TRIALS = {
  es: {
    open: { title: 'Te llevaron a juicio', body: 'Otros jugadores dudan de tu tiempo. Tienes 24 h para defenderte en Ranking → Juicios.' },
    culpable: { title: 'El jurado te declaró culpable', body: 'Pierdes lo ganado sin prueba esa semana y sales del ranking por 30 días.' },
    inocente: { title: 'Absuelto', body: 'El jurado te declaró inocente. Nadie puede juzgarte otra vez en 14 días.' },
    sin_quorum: { title: 'Juicio cerrado', body: 'No votaron suficientes jurados: quedas libre.' },
  },
  en: {
    open: { title: "You've been put on trial", body: 'Other players doubt your time. You have 24 h to defend yourself in Ranking → Trials.' },
    culpable: { title: 'The jury found you guilty', body: "You lose what you earned without proof that week and you're out of the ranking for 30 days." },
    inocente: { title: 'Acquitted', body: 'The jury found you innocent. Nobody can try you again for 14 days.' },
    sin_quorum: { title: 'Trial closed', body: "Not enough jurors voted: you're free." },
  },
};
export const trialFor = (kind, lang) => (TRIALS[lang] || TRIALS.en)[kind];

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
