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
  );
  $('#devices').replaceChildren(groupList(data.dispositivosConVariasCuentas, 'Ningún teléfono tiene más de una cuenta.'));
  $('#nets').replaceChildren(groupList(data.redesConVariasCuentas, 'Ninguna red tiene más de una cuenta.'));
  table(data.relojes);
}

$('#login').addEventListener('submit', (e) => {
  e.preventDefault();
  load($('#key').value.trim());
});
$('#reload').addEventListener('click', () => load(sessionStorage.getItem(KEY) || ''));

const saved = sessionStorage.getItem(KEY);
if (saved) load(saved);
