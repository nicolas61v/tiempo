// Panel de administración: cuentas repetidas por dispositivo o red, reinicios y muertes.
// Todo se pinta con textContent: los nombres los escribe la gente y nunca se interpretan como HTML.

const $ = (s) => document.querySelector(s);
const KEY = 'tiempo.admin';
const dt = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' });

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function dur(sec) {
  if (sec <= 0) return 'en cero';
  const d = Math.floor(sec / 86_400), h = Math.floor((sec % 86_400) / 3600), m = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, !d && `${m}m`].filter(Boolean).join(' ');
}

function card(label, value) {
  const c = el('div', null, 'card');
  c.append(el('b', String(value)), el('span', label));
  return c;
}

function groupList(groups, empty) {
  if (!groups.length) return el('p', empty, 'empty');
  const list = el('div', null, 'groups');
  for (const g of groups) {
    const row = el('div', null, 'group');
    row.append(el('b', `${g.cuentas} cuentas`), el('span', g.nombres.join(' · ')), el('code', g.id));
    list.append(row);
  }
  return list;
}

function table(rows) {
  const t = $('#users');
  const head = el('tr');
  for (const h of ['Nombre', 'Creado', 'Vida', 'Reinicios', 'Muertes', 'Le queda', 'Teléfono', 'Red']) head.append(el('th', h));
  const body = rows.map((r) => {
    const tr = el('tr', null, r.reinicios >= 2 ? 'flag' : '');
    tr.append(
      el('td', r.nombre || '(sin nombre)'),
      el('td', dt.format(r.creado)),
      el('td', String(r.vida)),
      el('td', String(r.reinicios)),
      el('td', String(r.muertes)),
      el('td', dur(r.restanteSeg)),
      el('td', r.dispositivo, 'mono'),
      el('td', r.red, 'mono'),
    );
    return tr;
  });
  t.replaceChildren(el('thead'), el('tbody'));
  t.tHead.append(head);
  t.tBodies[0].append(...body);
}

async function load(key) {
  $('#msg').textContent = 'Cargando…';
  const res = await fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' }).catch(() => null);
  if (!res) return void ($('#msg').textContent = 'Sin conexión.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    sessionStorage.removeItem(KEY);
    $('#login').hidden = false;
    $('#reload').hidden = true;
    $('#out').hidden = true;
    $('#msg').textContent = data.message || 'No se pudo cargar.';
    return;
  }
  sessionStorage.setItem(KEY, key);
  $('#login').hidden = true;
  $('#reload').hidden = false;
  $('#out').hidden = false;
  $('#msg').textContent = `Actualizado ${dt.format(data.ahora)}`;

  const t = data.totales;
  $('#totals').replaceChildren(
    card('relojes', t.relojes),
    card('vivos', t.vivos),
    card('en cero', t.enCero),
    card('reinicios voluntarios', t.reinicios),
    card('muertes', t.muertes),
    card('teléfonos', t.dispositivos),
    card('redes', t.redes),
    card('en el ranking', data.enRanking ?? 0),
    card('faltas (personas)', `${data.faltas?.total ?? 0} (${data.faltas?.personas ?? 0})`),
    card('juicios abiertos', data.juicios?.abierto ?? 0),
    card('culpables', data.juicios?.culpable ?? 0),
    card('absueltos', (data.juicios?.inocente ?? 0) + (data.juicios?.sin_quorum ?? 0)),
    card('ventas (USD)', (data.ventas || []).reduce((s, v) => s + v.usd, 0).toFixed(2)),
    ...(data.ventas || []).map((v) => card(`${v.producto} (${v.usd.toFixed(2)} USD)`, v.cantidad)),
  );
  $('#devices').replaceChildren(groupList(data.dispositivosConVariasCuentas, 'Ningún teléfono tiene más de una cuenta.'));
  $('#nets').replaceChildren(groupList(data.redesConVariasCuentas, 'Ninguna red tiene más de una cuenta.'));
  table(data.relojes);
}

/* Recuperar un reloj: buscar por la compra y darle una llave nueva (la vieja deja de servir; el reloj no cambia). */
async function admin(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${sessionStorage.getItem(KEY) || ''}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : { message: 'Sin conexión.' };
  if (!res?.ok) throw new Error(data.message || 'No se pudo.');
  return data;
}

let rekeyRef = '';
$('#rekey-find').addEventListener('submit', async (e) => {
  e.preventDefault();
  rekeyRef = $('#rekey-ref').value.trim();
  $('#rekey-out').hidden = false;
  $('#rekey-go').hidden = true;
  $('#rekey-note').hidden = true;
  $('#rekey-key').textContent = '';
  $('#rekey-clock').textContent = 'Buscando…';
  try {
    const c = await admin('GET', `/api/admin/clock?ref=${encodeURIComponent(rekeyRef)}`);
    const plus = c.plus?.active ? ` · Plus hasta ${dt.format(c.plus.until)}${c.plus.renews ? '' : ' (no se renueva)'}` : '';
    $('#rekey-clock').textContent = `${c.nickname || '(sin nombre)'} · vida ${c.lifeNo} · le queda ${dur(c.secondsLeft)}${plus}`;
    $('#rekey-go').hidden = false;
  } catch (err) {
    $('#rekey-clock').textContent = err.message;
  }
});
$('#rekey-go').addEventListener('click', async () => {
  $('#rekey-go').hidden = true;
  try {
    const r = await admin('POST', '/api/admin/rekey', { ref: rekeyRef });
    $('#rekey-key').textContent = r.token;
    $('#rekey-note').hidden = false;
  } catch (err) {
    $('#rekey-clock').textContent = err.message;
  }
});

$('#login').addEventListener('submit', (e) => {
  e.preventDefault();
  load($('#key').value.trim());
});
$('#reload').addEventListener('click', () => load(sessionStorage.getItem(KEY) || ''));

const saved = sessionStorage.getItem(KEY);
if (saved) load(saved);
