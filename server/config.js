import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// En local, las llaves pueden ir en un archivo .env (ignorado por git). En Railway van en Variables.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {}

const env = process.env;

export const config = {
  root,
  port: Number(env.PORT) || 3000,
  // Railway define RAILWAY_VOLUME_MOUNT_PATH al montar un volumen.
  dataDir: env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || path.join(root, 'data'),
  initialSeconds: Number(env.INITIAL_SECONDS) || 7 * 86_400,
  // SMMLV Colombia 2026 (Decreto 1469 de 2025). 1 día de vida = este valor / 30.
  minWage: Number(env.MIN_WAGE_MONTHLY) || 1_750_905,
  // Salario mínimo por hora en Estados Unidos (dólares): para quien vive allá, 1 día de vida = ese salario
  // × 40 h × 52 semanas / 12 / 30. Los demás países usan, por ahora, el de Colombia.
  usMinWageHourly: Number(env.MIN_WAGE_US_HOURLY) || 14,
  // Clave de la página /admin. Sin ella, el panel de administración queda apagado.
  adminToken: env.ADMIN_TOKEN || '',
  // Pagos con Lemon Squeezy (pasos en el README). Sin la llave, el secreto del webhook y las 4 variantes,
  // la tienda queda apagada. La tienda se descubre sola si la llave ve una sola.
  lemonsqueezy: {
    apiKey: (env.LEMONSQUEEZY_API_KEY || '').trim(),
    webhookSecret: (env.LEMONSQUEEZY_WEBHOOK_SECRET || '').trim(),
    storeId: (env.LEMONSQUEEZY_STORE_ID || '').trim(),
    variants: {
      plus: (env.LEMONSQUEEZY_VARIANT_PLUS || '').trim(),
      dia: (env.LEMONSQUEEZY_VARIANT_DIA || '').trim(),
      regalo: (env.LEMONSQUEEZY_VARIANT_REGALO || '').trim(),
      revivir: (env.LEMONSQUEEZY_VARIANT_REVIVIR || '').trim(),
    },
  },
  // Pesos por dólar: quien usa la app en dólares ve y escribe la plata en USD (por dentro todo es en pesos).
  usdCop: Number(env.USD_COP) || 4000,
  // A dónde vuelve la gente después de pagar si el navegador no dice de dónde salió (normalmente sí lo dice).
  publicUrl: (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, ''),
  onRailway: Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID),
  hasVolume: Boolean(env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR),
  vapid: {
    subject:
      env.VAPID_SUBJECT ||
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : 'mailto:alertas@tiempo.invalid'),
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  },
};
