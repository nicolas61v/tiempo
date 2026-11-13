import webpush from 'web-push';

const MESSAGES = {
  86400: { title: 'Menos de 24 horas', body: 'Tu reloj entró en su último día. Gana tiempo.' },
  3600: { title: 'Menos de una hora', body: 'El reloj no espera. Muévete.' },
  600: { title: 'Quedan 10 minutos', body: 'Último aviso antes de que se agote tu tiempo.' },
  0: { title: 'Tiempo agotado', body: 'Tu reloj llegó a cero. Puedes renacer.' },
};

// Recordatorio de "Mi día", según la hora de la persona.
const REMINDERS = [
  { until: 12, title: '¿Cómo va tu día?', body: 'Cuéntale al Guardián lo que llevas: lo bueno suma tiempo.' },
  { until: 18, title: '¿Qué has hecho hoy?', body: 'Cuéntale al Guardián antes de que se te olvide.' },
  { until: 24, title: 'Antes de que acabe el día', body: 'Cuéntale al Guardián qué hiciste. Lo que no le cuentas no suma.' },
];
export const reminderFor = (hour) => REMINDERS.find((r) => hour < r.until);

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
      await Promise.all(due.map((a) => sendToUser(a.userId, { ...MESSAGES[a.band], band: a.band, expiresAt: a.expiresAt })));
      // Un recordatorio viejo no sirve: si el teléfono no lo recibe en 2 h, se descarta.
      const reminders = store.claimReminders(Date.now());
      await Promise.all(
        reminders.map((r) => {
          const { title, body } = reminderFor(r.hour);
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
