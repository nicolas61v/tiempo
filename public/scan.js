// Escáner de QR dentro de la app: cámara trasera + lector nativo (Android) o jsQR (iPhone).
// Así el regalo llega a ESTE reloj. La cámara del sistema abre el link en el navegador, y en iPhone
// el navegador guarda su propio reloj, distinto al de la app instalada.

/** Código de 6 caracteres de un QR de Tiempo (link …/r/CÓDIGO o el código solo), o null. */
export function codeFromQr(text) {
  const s = String(text ?? '').trim();
  const m = /\/r\/([A-Za-z0-9]{6})\/?(?:[?#].*)?$/.exec(s) || /^([A-Za-z0-9]{6})$/.exec(s);
  return m ? m[1].toUpperCase() : null;
}

export const canScan = () => Boolean(globalThis.navigator?.mediaDevices?.getUserMedia);

/** Devuelve detect(video) → texto del QR o null. */
async function makeDetector() {
  if ('BarcodeDetector' in globalThis) {
    try {
      if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        const bd = new BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => (await bd.detect(video))[0]?.rawValue || null;
      }
    } catch {}
  }
  const { default: jsQR } = await import('./vendor/jsqr.mjs'); // ~40 KB: solo se baja si hace falta
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return (video) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    // Solo el cuadrado del centro (lo que se ve en el visor), reducido: rápido aun en celulares viejos.
    const side = Math.min(w, h);
    const size = Math.min(side, 560);
    canvas.width = canvas.height = size;
    ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    return jsQR(ctx.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: 'attemptBoth' })?.data || null;
  };
}

/**
 * Abre la cámara en <video> y llama onCode(código) al leer un QR de Tiempo, u onOther(texto) si lee
 * otro QR. Devuelve stop(). Lanza si no hay permiso o no hay cámara.
 */
export async function startScan(video, { onCode, onOther }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  let stopped = false;
  let timer = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };
  try {
    video.srcObject = stream;
    await video.play().catch(() => {});
    const detect = await makeDetector();
    const step = async () => {
      if (stopped) return;
      let text = null;
      try {
        text = await detect(video);
      } catch {}
      if (stopped) return;
      const code = text && codeFromQr(text);
      if (code) {
        stop();
        onCode(code);
        return;
      }
      if (text) onOther?.(text);
      timer = setTimeout(step, 150);
    };
    step();
  } catch (err) {
    stop();
    throw err;
  }
  return stop;
}
