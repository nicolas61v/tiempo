// Idiomas: inglés (por defecto) y español. Se elige en Ajustes y queda en este teléfono; cambiarlo recarga la app.
//
// Texto fijo del HTML: el inglés vive en index.html y el español en ES_STATIC, con la misma clave (data-i18n…).
// Texto dinámico: T('clave', { vars }) busca en DICT[idioma] (y si falta, en inglés). Una entrada puede ser
// texto con {variables} o una función (para plurales y frases que cambian de forma).

export const LANGS = ['en', 'es'];
const KEY = 'tiempo.lang';

function readLang() {
  try {
    const l = globalThis.localStorage?.getItem(KEY);
    return LANGS.includes(l) ? l : 'en';
  } catch {
    return 'en';
  }
}

export const LANG = readLang();
/** Formatos de números, fechas y moneda. */
export const LOCALE = LANG === 'es' ? 'es-CO' : 'en-US';

export function saveLang(lang) {
  try {
    localStorage.setItem(KEY, lang);
    return localStorage.getItem(KEY) === lang;
  } catch {
    return false;
  }
}

const n2 = (n, one, many) => (n === 1 ? one : many);

const EN = {
  'status.intro': 'Your clock',
  'status.ok': 'Time left',
  'status.low': 'Last day',
  'status.critical': 'Last hour',
  'status.dead': "Time's up",
  'unit.week': ({ n }) => `${n} ${n2(n, 'week', 'weeks')}`,
  'unit.day': ({ n }) => `${n} ${n2(n, 'day', 'days')}`,
  'unit.hour': ({ n }) => `${n} ${n2(n, 'hour', 'hours')}`,
  'clock.units': ['years', 'months', 'wks', 'days', 'hours', 'min', 'sec'],
  'clock.left': ({ y, mo, w, d, h, m }) => {
    const parts = [[y, 'year'], [mo, 'month'], [w, 'week'], [d, 'day'], [h, 'hour'], [m, 'minute']]
      .filter(([v]) => v)
      .map(([v, u]) => `${v} ${u}${v === 1 ? '' : 's'}`);
    return parts.length ? `${parts.join(', ')} left` : "Time's up";
  },
  'verdict.aprobado': 'Approved',
  'verdict.rechazado': 'Rejected',
  'verdict.necesita_prueba': 'Needs proof',
  'verdict.no_cuenta': "Doesn't count",
  earned: 'Earned',
  spent: 'Spent',
  'seal.photo': ' · ✓ with proof',
  'seal.judge': ' · ✓ Guardian',
  'note.to': ({ name }) => `To ${name || 'someone'}`,
  'note.from': ({ name }) => `From ${name || 'someone'}`,
  'note.code': 'Code {code}',
  now: 'now',
  today: 'Today',
  yesterday: 'Yesterday',
  'net.offline': 'No connection',
  'net.failed': 'Something went wrong',
  'recover.ok': 'We recovered your clock.',
  'recover.none': "It's not showing up yet. Try again in a few minutes or paste your key in Settings.",
  life: 'Life {n}',
  rebirthWith: 'Be reborn with {x}',
  expires: 'Runs out {date} at {time}',
  lifeLasted: 'This life lasted {x}.',
  yourRecord: ' Your record: {x}.',
  capHint: ' Up to {cap} h count every 24 h.',
  'formula.money': 'per day',
  'formula.base': '1 day of life = {dv}, one day of minimum wage',
  'formula.hours': '{dur} of {what}{rate}',
  'formula.hoursBase': '1 h of {what} = {dur} of life',
  moneyChip: ({ v }) => (v >= 1e6 ? `+${v / 1e6}M` : `+${v / 1e3}K`),
  'tx.seeEarn': 'See how much life what you earned is worth.',
  'tx.seeSpend': 'See how much life it cost you.',
  'tx.overCap': "That's over the limit: you already have {used} in the last 24 h.",
  'tx.short': "You can't afford it: that would leave you at zero.",
  'tx.after': "You'll have {x} left.",
  earn: 'Earn',
  spend: 'Spend',
  earnX: 'Earn {x}',
  spendX: 'Spend {x}',
  ofLife: '{x} of life',
  undo: 'Undo',
  undone: 'Undone',
  photos: ({ n }) => (n === 1 ? '1 photo' : `${n} photos`),
  guardian: 'Guardian',
  listenVerdict: 'Listen to this verdict',
  activity: 'Activity',
  capped: ' (cap)',
  dayTotal: 'Day total',
  photoN: 'Photo {n}',
  removePhoto: 'Remove photo',
  reviewing: 'The Guardian is reviewing…',
  'day.placeholder': 'Today I hit the gym for an hour, studied 2 h and sold 3 kits for 90,000…',
  'day.replyPlaceholder': 'Reply: explain better or upload proof…',
  'day.listening': "I'm listening…",
  'day.reply': 'Reply',
  'day.send': 'Send to Guardian',
  'day.repliesLeft': ({ n }) => (n === 1 ? '1 reply left.' : `${n} replies left.`),
  'day.accept': 'Accept {x}',
  'day.closeNoChange': 'Close without changes',
  'quota.none': "You've used your {per} chats for today. They reset at midnight.",
  'quota.full': 'You get {per} chats a day with the Guardian. They reset at midnight.',
  'quota.some': ({ left, per }) => `${left} of ${per} chats left today. They reset at midnight.`,
  maxPhotos: 'Up to 4 photos per message',
  badPhoto: "Couldn't read that photo",
  noDictation:
    "This browser doesn't support dictation (Brave blocks it for privacy). On your phone, tap the keyboard's microphone; on a computer, open the app in Chrome, Edge or Safari.",
  'mic.start': 'Dictate with your voice',
  'mic.stop': 'Stop dictating',
  'mic.denied': 'Allow the microphone for this site and try again.',
  'mic.none': "I can't find a microphone.",
  'mic.network': "Dictation couldn't connect. Check your internet or use the keyboard's microphone.",
  'mic.failed': 'Dictation failed. Try again.',
  'mic.open': "Couldn't open the microphone.",
  'speech.lang': 'en-US',
  'speech.dur': ({ s }) => {
    if (!s) return 'nothing';
    const a = Math.abs(s);
    const d = Math.floor(a / 86_400), h = Math.floor((a % 86_400) / 3_600), m = Math.floor((a % 3_600) / 60);
    const word = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
    const parts = [d && word(d, 'one day', 'days'), h && word(h, 'one hour', 'hours'), !d && m && word(m, 'one minute', 'minutes')];
    return `${s > 0 ? 'plus' : 'minus'} ${parts.filter(Boolean).join(' and ')}`;
  },
  'speech.total': '{msg} Day total: {dur}.',
  'speech.ready': "Got it. I'll read you the Guardian's verdicts.",
  'voice.on': 'Stop reading aloud',
  'voice.off': 'Read verdicts aloud',
  'day.empty': 'Tell it what you did today',
  'day.emptyReply': 'Write your reply or upload proof',
  'day.closed': 'Day closed with no changes',
  'day.discarded': 'Day discarded',
  qrCode: 'QR code',
  'share.pick': 'Choose how much time to give.',
  'share.all': "You can't give away all your time.",
  'share.after': "It leaves your clock now and you'll have {x} left. If nobody claims it in 10 min, it comes back.",
  'share.createX': 'Create {x} code',
  'share.create': 'Create code',
  'share.waiting': '{x} waiting for someone · expires in {m}:{ss}',
  'share.delivered': ({ name, x }) => `Delivered! ${name || 'Someone'} received ${x} of your time.`,
  'share.returned': 'Nobody claimed it: the time went back to your clock.',
  'share.canceled': 'Code canceled: your time is back.',
  'share.sixChars': 'The code has 6 characters',
  'share.got': ({ x, name }) => `+${x}: ${name || 'someone'} gave you time.`,
  'scan.code.title': 'Scan QR',
  'scan.code.hint': 'Point at the QR of whoever is giving you time.',
  'scan.code.other': "That QR isn't from Tiempo. Look for the one in Transfer → Send.",
  'scan.key.title': 'Scan key',
  'scan.key.hint': 'On your other device: Settings → Your key → View → Show QR.',
  'scan.key.other': "That QR isn't a Tiempo key.",
  'scan.first': 'First open or start your clock; then receive the time.',
  'scan.denied': 'No camera permission: allow it in your phone settings or type the code.',
  'scan.failed': "Couldn't open the camera. Type the code.",
  recordPrev: 'Record from previous lives: {x}',
  isKey: 'That\'s a key: tap "Use" to open your clock',
  'gift.app': 'Someone is giving you time. Start your clock to receive it.',
  'gift.browser':
    "Someone is giving you time (code {code}). If you already have Tiempo installed, open it and in Transfer → Receive scan the QR or type the code. If it's your first time, start here.",
  'gift.title': 'Receive on this clock?',
  'gift.text':
    "It will be added to this browser's clock ({name}). If you use Tiempo installed as an app, open it instead and in Transfer → Receive scan the QR or type the code {code}.",
  'gift.ok': 'Receive here',
  'gift.yourCode': 'Your code: {code}',
  reborn: 'Life {n}. You have {x}.',
  'push.on': 'On: we alert you at 24 h, 1 h and 10 min before the end.',
  'push.off': 'We alert you at 24 h, 1 h and 10 min before the end, even with the app closed.',
  'push.denied': 'Blocked. Turn them on in your browser settings.',
  'push.ios': 'On iPhone, first install the app (Share → Add to Home Screen).',
  'push.unsupported': "This browser doesn't support alerts.",
  'push.turnOn': 'Turn on',
  'push.turnOff': 'Turn off',
  'push.offToast': 'Alerts off',
  'push.onToast': 'Alerts on',
  'push.noPermission': 'No permission to notify',
  'push.failed': "Couldn't turn on alerts",
  'remind.21600': '6 hours',
  'remind.43200': '12 hours',
  'remind.86400': 'a day',
  'remind.off': "Off: we won't remind you of anything.",
  'remind.on': "If you don't tell the Guardian anything in {x}, we'll remind you. Never at night.",
  'remind.needsPush': "If you go {x} without telling the Guardian anything we'll remind you, but first turn on alerts.",
  'remind.offToast': 'Reminder off',
  'remind.onToast': "Done: we'll remind you after {x} without logging your day",
  'remind.pushToast': 'Now turn on alerts to get it',
  'install.hint': 'Put it on your home screen. Opens instantly and works offline.',
  'install.ios': 'In Safari: Share → Add to Home Screen.',
  rate: '1 day of life = {dv}, one day of Colombian minimum wage ({mw} a month).',
  'key.welcome': 'This is your key',
  'key.title': 'Your key',
  'key.new': 'Your new key',
  'key.saved': "I've saved it",
  'key.done': 'Done',
  'key.copy': 'Copy key',
  'key.copied': '✓ Key copied',
  'key.copiedToast': 'Key copied. Paste it in your notes or somewhere safe.',
  'key.copyFailed': "Couldn't copy it automatically: it's selected, copy it yourself.",
  started: 'Your time started running.',
  'name.isKey': "Your key can't be your name: nobody should see it",
  'name.saved': 'Done, {name}.',
  'name.removed': 'Name removed',
  'rotate.title': 'Change your key?',
  'rotate.text':
    "We'll give you a new key for this same clock: your time doesn't change. The old one stops working, so on your other devices you'll need to open it again with the new one (by scanning its QR).",
  'rotate.ok': 'Change key',
  'rotate.done': 'Key changed. Save it: the old one no longer works.',
  'use.invalid': "That key isn't valid",
  'use.same': "You're already using that key",
  'use.title': 'Use another key?',
  'use.text': 'This device will show that clock. Your current key stays saved here in case you want to go back.',
  'use.ok': 'Switch',
  'use.done': 'Clock linked',
  'use.missing': "That key doesn't exist",
  'reset.title': 'Start over?',
  'reset.text': ({ rem, x }) => `You lose this life${rem ? ` and the ${rem} you have left` : ''}. You're reborn with ${x}.`,
  'reset.ok': 'Restart',
};

const ES = {
  'status.intro': 'Tu reloj',
  'status.ok': 'Tiempo restante',
  'status.low': 'Último día',
  'status.critical': 'Última hora',
  'status.dead': 'Tiempo agotado',
  'unit.week': ({ n }) => `${n} ${n2(n, 'semana', 'semanas')}`,
  'unit.day': ({ n }) => `${n} ${n2(n, 'día', 'días')}`,
  'unit.hour': ({ n }) => `${n} ${n2(n, 'hora', 'horas')}`,
  'clock.units': ['años', 'meses', 'sem', 'días', 'horas', 'min', 'seg'],
  'clock.left': ({ y, mo, w, d, h, m }) => {
    const units = [[y, 'año', 'años'], [mo, 'mes', 'meses'], [w, 'semana', 'semanas'], [d, 'día', 'días'], [h, 'hora', 'horas'], [m, 'minuto', 'minutos']];
    const parts = units.filter(([v]) => v).map(([v, one, many]) => `${v} ${v === 1 ? one : many}`);
    return parts.length ? `Quedan ${parts.join(', ')}` : 'Tiempo agotado';
  },
  'verdict.aprobado': 'Aprobado',
  'verdict.rechazado': 'Rechazado',
  'verdict.necesita_prueba': 'Falta prueba',
  'verdict.no_cuenta': 'No cuenta',
  earned: 'Ganado',
  spent: 'Gastado',
  'seal.photo': ' · ✓ con prueba',
  'seal.judge': ' · ✓ Guardián',
  'note.to': ({ name }) => `Para ${name || 'alguien'}`,
  'note.from': ({ name }) => `De ${name || 'alguien'}`,
  'note.code': 'Código {code}',
  now: 'ahora',
  today: 'Hoy',
  yesterday: 'Ayer',
  'net.offline': 'Sin conexión',
  'net.failed': 'Algo falló',
  'recover.ok': 'Recuperamos tu reloj.',
  'recover.none': 'Todavía no aparece. Intenta en unos minutos o pega tu llave en Ajustes.',
  life: 'Vida {n}',
  rebirthWith: 'Renacer con {x}',
  expires: 'Se agota el {date} a las {time}',
  lifeLasted: 'Esta vida duró {x}.',
  yourRecord: ' Tu récord: {x}.',
  capHint: ' Cuentan máximo {cap} h cada 24 h.',
  'formula.money': 'por día',
  'formula.base': '1 día de vida = {dv}, un salario mínimo diario',
  'formula.hours': '{dur} de {what}{rate}',
  'formula.hoursBase': '1 h de {what} = {dur} de vida',
  moneyChip: ({ v }) => (v >= 1e6 ? `+${v / 1e6} M` : `+${v / 1e3} mil`),
  'tx.seeEarn': 'Mira cuánta vida vale lo que ganaste.',
  'tx.seeSpend': 'Mira cuánta vida te costó.',
  'tx.overCap': 'Te pasas del máximo: ya llevas {used} en las últimas 24 h.',
  'tx.short': 'No te alcanza: eso te dejaría en cero.',
  'tx.after': 'Te quedarán {x}.',
  earn: 'Ganar',
  spend: 'Gastar',
  earnX: 'Ganar {x}',
  spendX: 'Gastar {x}',
  ofLife: '{x} de vida',
  undo: 'Deshacer',
  undone: 'Movimiento deshecho',
  photos: ({ n }) => (n === 1 ? '1 foto' : `${n} fotos`),
  guardian: 'Guardián',
  listenVerdict: 'Escuchar este veredicto',
  activity: 'Actividad',
  capped: ' (tope)',
  dayTotal: 'Total del día',
  photoN: 'Foto {n}',
  removePhoto: 'Quitar foto',
  reviewing: 'El Guardián está revisando…',
  'day.placeholder': 'Hoy fui al gym una hora, estudié inglés 2 h y vendí 3 kits por 90 mil…',
  'day.replyPlaceholder': 'Replica: explica mejor o sube una prueba…',
  'day.listening': 'Te escucho…',
  'day.reply': 'Replicar',
  'day.send': 'Enviar al Guardián',
  'day.repliesLeft': ({ n }) => (n === 1 ? 'Te queda 1 réplica.' : `Te quedan ${n} réplicas.`),
  'day.accept': 'Aceptar {x}',
  'day.closeNoChange': 'Cerrar sin cambios',
  'quota.none': 'Ya usaste tus {per} charlas de hoy. Se renuevan a medianoche.',
  'quota.full': 'Tienes {per} charlas por día con el Guardián. Se renuevan a medianoche.',
  'quota.some': ({ left, per }) =>
    `Hoy te ${left === 1 ? 'queda 1 charla' : `quedan ${left} charlas`} de ${per}. Se renuevan a medianoche.`,
  maxPhotos: 'Máximo 4 fotos por mensaje',
  badPhoto: 'No pude leer esa foto',
  noDictation:
    'Este navegador no trae dictado (Brave lo bloquea por privacidad). En el celular toca el micrófono del teclado; en el PC abre la app en Chrome, Edge o Safari.',
  'mic.start': 'Dictar con la voz',
  'mic.stop': 'Dejar de dictar',
  'mic.denied': 'Permite el micrófono para este sitio y vuelve a intentar.',
  'mic.none': 'No encuentro un micrófono conectado.',
  'mic.network': 'El dictado no pudo conectarse. Revisa tu internet o usa el micrófono del teclado.',
  'mic.failed': 'El dictado falló. Intenta otra vez.',
  'mic.open': 'No pude abrir el micrófono.',
  'speech.lang': 'es-CO',
  'speech.dur': ({ s }) => {
    if (!s) return 'nada';
    const a = Math.abs(s);
    const d = Math.floor(a / 86_400), h = Math.floor((a % 86_400) / 3_600), m = Math.floor((a % 3_600) / 60);
    const word = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
    const parts = [d && word(d, 'un día', 'días'), h && word(h, 'una hora', 'horas'), !d && m && word(m, 'un minuto', 'minutos')];
    return `${s > 0 ? 'más' : 'menos'} ${parts.filter(Boolean).join(' y ')}`;
  },
  'speech.total': '{msg} Total del día: {dur}.',
  'speech.ready': 'Listo. Te leo los veredictos del Guardián.',
  'voice.on': 'Dejar de leer en voz alta',
  'voice.off': 'Leer los veredictos en voz alta',
  'day.empty': 'Cuéntale qué hiciste hoy',
  'day.emptyReply': 'Escribe tu réplica o sube una prueba',
  'day.closed': 'Día cerrado sin cambios',
  'day.discarded': 'Día descartado',
  qrCode: 'Código QR',
  'share.pick': 'Elige cuánto tiempo regalar.',
  'share.all': 'No puedes regalar todo tu tiempo.',
  'share.after': 'Sale de tu reloj ya y te quedan {x}. Si nadie lo recibe en 10 min, vuelve.',
  'share.createX': 'Crear código de {x}',
  'share.create': 'Crear código',
  'share.waiting': '{x} esperando a alguien · expira en {m}:{ss}',
  'share.delivered': ({ name, x }) => `¡Entregado! ${name || 'Alguien'} recibió ${x} de tu tiempo.`,
  'share.returned': 'Nadie lo reclamó: el tiempo volvió a tu reloj.',
  'share.canceled': 'Código cancelado: tu tiempo volvió.',
  'share.sixChars': 'El código tiene 6 caracteres',
  'share.got': ({ x, name }) => `+${x}: ${name || 'alguien'} te regaló tiempo.`,
  'scan.code.title': 'Escanear QR',
  'scan.code.hint': 'Apunta al QR de quien te regala tiempo.',
  'scan.code.other': 'Ese QR no es de Tiempo. Busca el de Transferir → Enviar.',
  'scan.key.title': 'Escanear llave',
  'scan.key.hint': 'En tu otro dispositivo: Ajustes → Tu llave → Ver → Mostrar QR.',
  'scan.key.other': 'Ese QR no es una llave de Tiempo.',
  'scan.first': 'Primero abre o empieza tu reloj; luego recibe el tiempo.',
  'scan.denied': 'Sin permiso para la cámara: actívalo en los ajustes del celular o escribe el código.',
  'scan.failed': 'No se pudo abrir la cámara. Escribe el código.',
  recordPrev: 'Récord de vidas anteriores: {x}',
  isKey: 'Eso es una llave: tócale «Usar» para abrir tu reloj',
  'gift.app': 'Alguien te está regalando tiempo. Empieza tu reloj para recibirlo.',
  'gift.browser':
    'Te están regalando tiempo (código {code}). Si ya tienes Tiempo instalado, ábrelo y en Transferir → Recibir escanea el QR o escribe el código. Si es tu primera vez, empieza aquí.',
  'gift.title': '¿Recibir en este reloj?',
  'gift.text':
    'Se sumará al reloj de este navegador ({name}). Si usas Tiempo instalado como app, mejor ábrela y en Transferir → Recibir escanea el QR o escribe el código {code}.',
  'gift.ok': 'Recibir aquí',
  'gift.yourCode': 'Tu código: {code}',
  reborn: 'Vida {n}. Tienes {x}.',
  'push.on': 'Activas: te avisamos a 24 h, 1 h y 10 min del final.',
  'push.off': 'Te avisamos a 24 h, 1 h y 10 min del final, aunque la app esté cerrada.',
  'push.denied': 'Bloqueadas. Actívalas en los ajustes del navegador.',
  'push.ios': 'En iPhone, primero instala la app (Compartir → Agregar a inicio).',
  'push.unsupported': 'Este navegador no soporta alertas.',
  'push.turnOn': 'Activar',
  'push.turnOff': 'Desactivar',
  'push.offToast': 'Alertas desactivadas',
  'push.onToast': 'Alertas activadas',
  'push.noPermission': 'Sin permiso para notificar',
  'push.failed': 'No se pudieron activar las alertas',
  'remind.21600': '6 horas',
  'remind.43200': '12 horas',
  'remind.86400': 'un día',
  'remind.off': 'Apagado: no te recordamos nada.',
  'remind.on': 'Si en {x} no le cuentas nada al Guardián, te lo recordamos. Nunca de noche.',
  'remind.needsPush': 'Cada {x} sin contarle nada al Guardián te lo recordamos, pero primero activa las alertas.',
  'remind.offToast': 'Recordatorio apagado',
  'remind.onToast': 'Listo: te recordamos cada {x} sin contar tu día',
  'remind.pushToast': 'Ahora activa las alertas para recibirlo',
  'install.hint': 'Ponla en tu pantalla de inicio. Abre al instante y funciona sin conexión.',
  'install.ios': 'En Safari: Compartir → Agregar a pantalla de inicio.',
  rate: '1 día de vida = {dv}, un salario mínimo diario ({mw} al mes).',
  'key.welcome': 'Esta es tu llave',
  'key.title': 'Tu llave',
  'key.new': 'Tu llave nueva',
  'key.saved': 'Ya la guardé',
  'key.done': 'Listo',
  'key.copy': 'Copiar llave',
  'key.copied': '✓ Llave copiada',
  'key.copiedToast': 'Llave copiada. Pégala en tus notas o en un lugar seguro.',
  'key.copyFailed': 'No pude copiarla sola: ya está seleccionada, cópiala tú.',
  started: 'Tu tiempo empezó a correr.',
  'name.isKey': 'Tu llave no puede ser tu nombre: nadie debe verla',
  'name.saved': 'Listo, {name}.',
  'name.removed': 'Nombre borrado',
  'rotate.title': '¿Cambiar tu llave?',
  'rotate.text':
    'Te damos una llave nueva para este mismo reloj: tu tiempo no cambia. La vieja deja de servir, así que en tus otros dispositivos tendrás que abrirlo de nuevo con la nueva (escaneando su QR).',
  'rotate.ok': 'Cambiar llave',
  'rotate.done': 'Llave cambiada. Guárdala: la anterior ya no sirve.',
  'use.invalid': 'Esa llave no es válida',
  'use.same': 'Ya estás usando esa llave',
  'use.title': '¿Usar otra llave?',
  'use.text': 'Este dispositivo mostrará ese reloj. Tu llave actual queda guardada aquí por si quieres volver.',
  'use.ok': 'Cambiar',
  'use.done': 'Reloj vinculado',
  'use.missing': 'Esa llave no existe',
  'reset.title': '¿Empezar de nuevo?',
  'reset.text': ({ rem, x }) => `Pierdes esta vida${rem ? ` y los ${rem} que te quedan` : ''}. Renaces con ${x}.`,
  'reset.ok': 'Reiniciar',
};

/** Texto fijo de index.html en español (el inglés está en el propio HTML). */
export const ES_STATIC = {
  'a.history': 'Historial',
  'a.settings': 'Ajustes',
  'recover.text': 'No encontramos tu reloj en el servidor, pero tu llave sigue guardada en este teléfono.',
  'recover.btn': 'Reintentar',
  intro:
    'Empiezas con <b id="intro-initial"></b>. Vivir cuesta un día por día. Cada día cuéntale al Guardián qué hiciste: él decide qué te suma y qué te resta. Tienes <b>{n} charlas</b> con él por día; se renuevan a medianoche. Si tu reloj llega a cero, se acabó.',
  'ph.name': 'Tu nombre o apodo (opcional)',
  'a.name': 'Tu nombre o apodo, máximo 32 caracteres',
  start: 'Empezar',
  haveKey: 'Ya tengo una llave',
  'orb.money': 'Dinero',
  'orb.day': 'Mi día',
  'orb.share': 'Transferir',
  'a.tx': 'Mover tiempo',
  earn: 'Ganar',
  spend: 'Gastar',
  'a.category': 'Categoría',
  clear: 'Borrar',
  'a.pesos': 'Valor en pesos colombianos',
  'ph.what': '¿En qué? (opcional)',
  'day.title': 'Mi día',
  'day.sub': 'Cuéntale (o díctale) al Guardián qué hiciste. Gym y estudio necesitan foto; la plata va en tu palabra.',
  'a.readAloud': 'Leer los veredictos en voz alta',
  photo: 'Foto',
  'a.dictate': 'Dictar con la voz',
  'day.discard': 'Descartar este día',
  'share.title': 'Transferir tiempo',
  send: 'Enviar',
  receive: 'Recibir',
  'share.cancel': 'Cancelar y recuperar mi tiempo',
  scanQr: 'Escanear QR',
  orType: 'o escribe el código',
  'ph.code': 'CÓDIGO',
  'a.code': 'Código de tiempo',
  receiveTime: 'Recibir tiempo',
  cancel: 'Cancelar',
  'h.earned': 'Ganado',
  'h.spent': 'Gastado',
  'h.lived': 'Vivido',
  'h.empty': 'Aún no hay movimientos. Tu tiempo ya está corriendo.',
  settings: 'Ajustes',
  language: 'Idioma',
  'a.language': 'Idioma de la app',
  rateTitle: 'Tu tasa de cambio',
  alerts: 'Alertas',
  remindTitle: 'Recordarme contar mi día',
  'a.remind': 'Cada cuánto recordarte contar tu día',
  remindNo: 'No',
  install: 'Instalar',
  yourName: 'Tu nombre',
  'ph.nick': 'Nombre o apodo',
  save: 'Guardar',
  yourKey: 'Tu llave',
  'key.sub': 'Es tu identificador: abre este reloj en otro dispositivo. No la compartas.',
  view: 'Ver',
  'rotate.row': 'Cambiar tu llave',
  'rotate.sub': 'Si alguien más la vio. Tu reloj queda igual; la llave vieja deja de servir en todos lados.',
  change: 'Cambiar',
  'ph.pasteKey': 'Pegar una llave',
  'a.scanKey': 'Escanear el QR de una llave',
  use: 'Usar',
  'reset.row': 'Empezar de nuevo',
  'reset.sub': 'Pierdes esta vida y renaces desde cero.',
  restart: 'Reiniciar',
  privacy:
    'Privacidad: para detectar cuentas repetidas guardamos un identificador anónimo de este teléfono y una huella cifrada de tu red. Nunca guardamos tu IP.',
  'key.text':
    'Es tu <b>identificador</b> en Tiempo: con ella abres tu reloj en otro celular o lo recuperas si borras la app. No hay contraseña, así que <b>si la pierdes, pierdes tu reloj</b>. No se la muestres a nadie.',
  'key.qrText':
    'En tu otro celular, abre Tiempo → Ajustes → <b>escanear llave</b> (junto a «Pegar una llave»). Muéstralo solo en tus dispositivos.',
  showQr: 'Mostrar QR',
  yes: 'Sí',
};

export const DICT = { en: EN, es: ES };

/** Texto en el idioma actual. vars rellena {nombre} o se pasa a la función de la entrada. */
export function T(key, vars = {}) {
  const e = DICT[LANG][key] ?? EN[key];
  if (e == null) return key;
  if (typeof e === 'function') return e(vars);
  if (typeof e !== 'string') return e;
  return e.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/**
 * Traduce el HTML fijo: data-i18n (texto), data-i18n-html (texto con <b>, de este archivo: confiable),
 * data-i18n-ph (placeholder) y data-i18n-aria (aria-label). En inglés no hace nada: ya viene así.
 */
export function translatePage(vars = {}, root = document) {
  document.documentElement.lang = LANG;
  if (LANG === 'en') return;
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const s = ES_STATIC[node.dataset.i18n];
    if (s) node.textContent = fill(s);
  }
  for (const node of root.querySelectorAll('[data-i18n-html]')) {
    const s = ES_STATIC[node.dataset.i18nHtml];
    if (s) node.innerHTML = fill(s);
  }
  for (const node of root.querySelectorAll('[data-i18n-ph]')) {
    const s = ES_STATIC[node.dataset.i18nPh];
    if (s) node.placeholder = s;
  }
  for (const node of root.querySelectorAll('[data-i18n-aria]')) {
    const s = ES_STATIC[node.dataset.i18nAria];
    if (s) node.setAttribute('aria-label', s);
  }
}
