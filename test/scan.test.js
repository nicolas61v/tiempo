import { test } from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../public/vendor/qrcode.mjs';
import jsQR from '../public/vendor/jsqr.mjs';
import { codeFromQr, keyFromQr, readQr } from '../public/scan.js';

/** Pinta un QR como lo hace la app (módulos oscuros sobre fondo claro) y devuelve sus píxeles RGBA. */
function render(text, { scale = 6, quiet = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * scale;
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.floor(y / scale) - quiet;
      const c = Math.floor(x / scale) - quiet;
      const dark = r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
      const i = (y * size + x) * 4;
      px.set(dark ? [0x0c, 0x1a, 0x08, 255] : [0xea, 0xf8, 0xe2, 255], i);
    }
  }
  return { px, size };
}

test('escáner: lee el QR que muestra la app y saca el código', () => {
  const { px, size } = render('https://tiempo-production-79dc57d3.up.railway.app/r/AB2CD3');
  const read = jsQR(px, size, size, { inversionAttempts: 'attemptBoth' });
  assert.equal(codeFromQr(read?.data), 'AB2CD3');
});

test('escáner: solo acepta códigos de Tiempo', () => {
  assert.equal(codeFromQr('https://tiempo.app/r/ab2cd3'), 'AB2CD3');
  assert.equal(codeFromQr('http://127.0.0.1:3000/r/AB2CD3/?x=1#y'), 'AB2CD3');
  assert.equal(codeFromQr('  ab2cd3 '), 'AB2CD3'); // el código solo
  assert.equal(codeFromQr('https://tiempo.app/r/AB2CD34'), null);
  assert.equal(codeFromQr('https://otra.cosa/menu'), null);
  assert.equal(codeFromQr('WIFI:S:casa;T:WPA;P:1234;;'), null);
  assert.equal(codeFromQr(null), null);
});

test('escáner: el QR de la llave lleva solo la llave y se lee igual', () => {
  const key = 'tk_PRUEBAprueba0000000000xx';
  const { px, size } = render(key);
  const read = jsQR(px, size, size, { inversionAttempts: 'attemptBoth' });
  assert.deepEqual(readQr(read?.data), { kind: 'key', value: key });
  assert.deepEqual(readQr('https://tiempo.app/r/AB2CD3'), { kind: 'code', value: 'AB2CD3' });
  assert.equal(keyFromQr(' tk_PRUEBAprueba0000000000xx\n'), key);
  assert.equal(keyFromQr('tk_corta'), null);
  assert.equal(keyFromQr('https://evil.example/?k=tk_PRUEBAprueba0000000000xx'), null); // solo la llave sola
  assert.equal(readQr('hola'), null);
});
