import webpush from 'web-push';

const MESSAGES = {
  86400: { title: 'Menos de 24 horas', body: 'Tu reloj entró en su último día. Gana tiempo.' },
  3600: { title: 'Menos de una hora', body: 'El reloj no espera. Muévete.' },
  600: { title: 'Quedan 10 minutos', body: 'Último aviso antes de que se agote tu tiempo.' },
  0: { title: 'Tiempo agotado', body: 'Tu reloj llegó a cero. Puedes renacer.' },
};

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

  async function sendToUser(userId, payload) {
    const body = JSON.stringify(payload);
    await Promise.all(
      store.subsFor(userId).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
            TTL: 6 * 3600,
            urgency: 'high',
            topic: 'tiempo', // un aviso nuevo reemplaza al pendiente
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
