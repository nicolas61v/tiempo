# Tiempo: plan de trabajo

> Para quien retome el proyecto (persona o Claude). Lee **Reglas que no se rompen** antes de tocar nada.
> Actualizado: 2026-11-15.

## Qué es y qué ya existe

PWA móvil "Tiempo": un reloj de vida inspirado en *El precio del mañana*. Empiezas con 1 semana, vivir
cuesta 1 día por día y, si llega a cero, se acabó. **1 día de vida = 1 día de salario mínimo del país donde vives**:
Colombia (SMMLV 2026 $1.750.905 / 30 = $58.364) o Estados Unidos (US$14/h × 40 h × 52 / 12 / 30 = US$80,89).
Los demás países usan, por ahora, el de Colombia (pedido del dueño, 2026-11-16).

- **Stack**: Node 24 sin framework, SQLite integrado (`node:sqlite`) con migraciones versionadas
  (`MIGRATIONS` en `server/store.js`, hoy v1–v11), `web-push` y el SDK de Anthropic. Frontend vanilla sin
  build en `public/`. Detalle en `README.md`.
- **Deploy**: push a `main` → Railway despliega solo. Volumen en `/data`. Producción:
  **`https://app.mylifetime.cc`** (también responde `tiempo-production-79dc57d3.up.railway.app`).
- **Dominio** `mylifetime.cc` (DNS en Cloudflare): la **landing** vive en `https://mylifetime.cc`, en otro repo
  (`nicolas61v/mylifetime-landing`, Astro, desplegado en Netlify). No mezclarlas: el dueño las quiere separadas.
  `hello@mylifetime.cc` es un reenvío de Cloudflare al correo del dueño.
- **Ya hecho**:
  - Reloj (años · meses · semanas · días · horas · min · seg) que se ajusta a cualquier ancho de pantalla.
  - **Mi día**: le cuentas al Guardián (Claude Haiku 5.5, `server/judge.js`; el dueño lo eligió así) qué
    hiciste, con fotos como prueba, y él decide qué suma. 7 charlas por fecha (se renuevan a medianoche en la
    hora del teléfono; `DAYS_PER_DAY` en `store.js`).
  - **Dinero**: ingresos e inversión suman; gastos restan (en tu palabra).
  - **Transferir**: código de 6 letras + QR; escáner de QR dentro de la app (`public/scan.js`: lector
    nativo en Android, jsQR en iPhone). El historial dice "De Nico" / "Para Pipe".
  - **Llave**: identificador anónimo (no hay cuentas ni contraseña). QR de la llave para abrir el reloj en
    otro dispositivo, y "Cambiar tu llave" (`POST /api/me/key`).
  - Alertas push (24 h, 1 h, 10 min, cero) y recordatorio de "Mi día" (6/12/24 h, nunca de 22:00 a 8:00).
  - Anti-abuso (dispositivo anónimo + huella cifrada de red) y panel `/admin`.
  - La app se actualiza sola al volver a ella (si hay una hoja abierta, al cerrarla).
  - **Idiomas**: inglés (por defecto, decisión del dueño) y español; se cambia en Ajustes → Language y queda
    en el teléfono (`public/i18n.js`). El servidor responde errores, avisos push y al Guardián en el idioma
    de la app (encabezado `X-Lang`, columna `users.lang`). La economía sigue en pesos colombianos.
  - **En producción desde el 2026-11-16**: pagos con Creem (tienda encendida en modo de prueba; falta el modo real),
    ranking con ligas y perfiles públicos, juicios del jurado, límites de dinero con confianza del Guardián, un
    Guardián que exige que el día sea humanamente posible y salario por país. Detalle en la tarea 2 y en el
    `README.md`. Migraciones v10 y v11 (solo agregan).

## Reglas que no se rompen

1. **Ninguna actualización puede alterar el reloj de nadie** (`expires_at`). Es la regla más importante del
   dueño. Migraciones: solo se agregan al final de `MIGRATIONS`, nunca se edita una publicada, y cada una
   lleva su prueba de que `expiresAt` no cambia (ver las de v6, v7 y v8 en `test/store.test.js`). Antes de
   migrar, el servidor ya guarda una copia completa de la base.
2. **Reloj sonda en cada deploy**: antes y después, `GET /api/state` con la llave de un reloj de prueba en
   producción y comparar `expiresAt`. Si no tienes una sonda, crea una (`POST /api/session` con nombre
   `sonda-deploy`). Su llave **no** va al repo.
3. **Nunca una llave real (`tk_…`) en el repo**: es público y la llave es la única credencial del reloj.
   En pruebas usa llaves inventadas. Antes de cada commit: `git diff --cached | grep -E "tk_[A-Za-z0-9_-]{20,}"`.
4. **Secretos** (`ANTHROPIC_API_KEY`, `ADMIN_TOKEN`, VAPID, claves de pagos) solo en las Variables de
   Railway o en `.env` local. Nunca se piden por chat ni se suben.
5. **Los relojes viven en el `localStorage` de cada dominio** (y en iPhone, la app instalada y Safari son
   almacenamientos distintos). Cambiar de dominio o de origen = la gente no encuentra su reloj si no se
   migra la llave. Al probar, nunca borres el estado del navegador del dueño: usa `127.0.0.1` u otro perfil.
6. **Probar en tamaño celular** (320, 375, 390 y 430 px de ancho, y 320×568). La app envía
   `frame-ancestors 'none'`: usa Chrome/Edge sin ventana + DevTools Protocol
   (`Emulation.setDeviceMetricsOverride`), no un iframe. Para la cámara: `--use-fake-device-for-media-stream`
   y `--use-file-for-fake-video-capture=archivo.y4m`.
7. Todo en **español** (interfaz, commits, mensajes) hasta que haya idiomas. Commits pequeños por tema. El
   dueño quiere **push a `main` apenas algo esté probado**.

## Cómo trabajar

```bash
npm install
npm test        # node --test: test/store.test.js, test/scan.test.js
npm start       # http://127.0.0.1:3000 (claves en .env)
```

Sin `ANTHROPIC_API_KEY` el Guardián queda apagado, pero todo lo demás funciona.

---

## Tareas, en este orden

### 1. Dominio propio: hecho (2026-11-16)

La app está en `app.mylifetime.cc` y la landing en `mylifetime.cc` (repo aparte). No hizo falta la mudanza de
relojes del dominio viejo: nadie usaba la app todavía (decisión del dueño). Desde ahora el origen de la app es
`app.mylifetime.cc` y **no se cambia** (regla 5). Los links con `?lang=es` (los de la landing en español) abren la
app en español y lo dejan guardado.

### 2. Pagos, ranking y juicios: en producción (pagos en modo de prueba; falta el modo real)

Pedido del dueño (2026-11-15): Stripe en una rama aparte y "dejar todo listo para solo pegar la clave y el
webhook"; ranking para ver quién va ganando más tiempo y **qué hace cada uno**; un límite a lo que se gana por
dinero; un Guardián que no se trague días imposibles ("9 h de gym", "aprendí 10 cálculos") y que pregunte por
ingresos raros (1.000 USD de un día para otro), pero que confíe más en quien ya los probó; y juicios de los
jugadores contra quien sea sospechosamente rico en tiempo.

**Qué hay** (todo con pruebas en `test/pay.test.js`, `test/social.test.js` y `test/store.test.js`; 75 en total en el proyecto):

- **Creem sin dependencias** (`server/payments.js`). Historia: Stripe no deja cobrar desde Colombia (2026-11-15);
  Lemon Squeezy cerró a tiendas nuevas al unirse a Stripe (2026-11-16); Creem acepta personas naturales de
  Colombia, cobra 3,9 % + US$0,40 y paga por banco o USDC. Checkout por redirección (`POST /v1/checkouts` con el
  `product_id`, `request_id` = la referencia `ck_…` y metadatos), webhook con firma HMAC (`creem-signature`)
  verificada a mano. Lo que se entrega sale del **producto pagado**, no de los metadatos. Las referencias de pago
  son la transacción (`tran_…`): así un reembolso encuentra lo que acreditó y el primer cobro de Plus (llega con el
  checkout y otra vez como `subscription.paid`, en cualquier orden) cuenta una vez. Plus se cancela al fin del
  periodo (`/cancel` con `mode: scheduled`) y se retoma con `/resume`. Capa intercambiable: el resto de la app solo
  ve acciones (`paid`, `renewed`, `plus_ended`, `plus_renews`, `refunded`). Al volver del pago, la app solo espera
  el webhook. Al arrancar, `check()` revisa cada producto y deja en los logs lo que no cuadre.
- **Productos** (precios en `PRODUCTS`, decididos por el dueño el 2026-11-16): Plus US$4,99/mes · Revivir US$4,99 (1 día,
  conserva vida, récord e historial) · +4 días US$2,99 (una compra por semana, nunca en la última hora) · Regalo de 1 semana US$4,99 (código + QR
  por el mismo flujo de transferencias; uno comprado por persona y semana). Lo comprado nunca cuenta en el
  ranking. Plus nunca da tiempo. Renacer gratis sigue siendo el botón principal en cero.
- **Límites de dinero** (`MONEY` en `economy.js`): 7 días de vida por semana en tu palabra, 30 para todos. El
  Guardián marca `proof` cuando una foto respalda un ítem (el servidor solo lo acepta si hay fotos); un ingreso
  ≥ 7 días aprobado con prueba sube la confianza (`users.income_trust`).
- **Día humano**: estudio + ejercicio + proyecto ≤ 16 h en 24 h (servidor) y reglas de plausibilidad en el prompt.
  El Guardián recibe un bloque "Datos del servidor" (horas ya contadas, dinero que le cabe, verificado o no,
  ingresos de 30 días). Plus usa `claude-sonnet-5-5` con `fallbacks: 'default'`; los demás, Haiku 5.5.
- **Ranking** (`server/store-social.js`): por elección y con nombre; tablas *semana* y *tiempo*; ligas; perfil
  público con de dónde sale el tiempo y las actividades de 30 días.
- **Juicios de 2 días** (reglas en la cabecera de `store-social.js`, `TRIAL`): día 1 citación pública con lo que
  está en juego y defensa obligatoria con pruebas; día 2 veredicto secreto (solo se ve cuántos votaron). Culpable:
  lo en juego se reparte entre quienes votaron culpable. Inocente: conserva lo en disputa y gana 1 día, igual que
  quienes votaron inocente. Potestad para citar por **tiempo vivido de verdad** (15/30/90 días = 1/2/3). Un voto
  por persona al día. **El Guardián también cita** (campo `summon` del veredicto), solo a quien está en el ranking.
- **Perfil y moneda** (pedido del 2026-11-15): país obligatorio al registrarse, "¿a qué te dedicas?" opcional (lo
  revisa el Guardián y lo usa de contexto), moneda COP o USD (por dentro todo en pesos; `USD_COP`).
- **Faltas por contenido sexual** en todo lo que se sube: 1 día, 1 semana, 1 mes, 3 meses, 1 año; nunca se borran.
- Interpretación de Claude, a confirmar con el dueño: al absuelto **no** se le duplica lo que estaba en disputa (lo
  conserva y gana 1 día): duplicarlo invitaba a que amigos se citaran entre sí para ganar.

**Para publicarlo** (en este orden):

1. ~~Productos, llave y webhook de prueba~~: hecho el 2026-11-16. La tienda de producción está **encendida en modo
   de prueba**: en los logs sale `pagos con Creem listos (modo de prueba)`. Los 4 productos y el webhook "Tiempo
   app" (18 eventos) están en Creem, y las 6 variables `CREEM_*` en Railway.
2. Probado en producción el 2026-11-16 con la tarjeta 4111:
   - El dueño compró Plus, +4 días y el regalo desde la app. Los tres llegaron como `→ paid`, y el primer cobro de
     Plus (llega como `subscription.paid` y como `checkout.completed`) contó una vez.
   - Un reembolso completo de +4 días desde el panel de Creem llegó como `refund.created → refunded`.
   - El webhook rechaza los avisos sin firma o con firma falsa (400).
   - **Falta**: Revivir desde la app (el reloj de prueba `prueba-pagos-revivir` ya está en cero), reclamar un
     regalo desde otro reloj, y cancelar y retomar Plus.
   - Una compra hecha desde el link público de un producto (por ejemplo, el botón "Prueba un pago de prueba" del
     panel de Creem) no dice de qué reloj es. La app la anota como `pago ord_… sin reloj` y no acredita nada: hay
     que reembolsarla a mano. Por eso no se publican los links de los productos ni la tienda pública de Creem.
   - Claude no puede escribir números de tarjeta (ni de prueba) en pagos que salen de producción: crea el pago con
     `POST /api/checkout` y la llave de un reloj de prueba, y el dueño paga.
3. ~~"Mi día" con la API real~~: probado el 2026-11-16.
   - Un día imposible (9 h de gym, 10 h de cálculo) lo recortó a 2 h y 3 h y pidió fotos.
   - US$1.000 sin prueba no los contó y pidió el comprobante.
   - Un día normal sin fotos pidió la foto.
   - Falta: un ingreso grande con un comprobante real (debe dar confianza).
4. Listo para la revisión de Creem (2026-11-16), según su guía de revisión de cuentas:
   - Landing: términos con uso aceptable y moderación con IA, y aviso de que Tiempo no está afiliado a Anthropic.
   - App: aviso de Creem como comerciante registrado antes de pagar, y enlaces a Términos, Privacidad,
     Reembolsos y `hello@mylifetime.cc` en la tienda y en Ajustes.
   - Tienda de Creem: nombre "Tiempo" (slug `mylifetime`), logo y verde de la app en el checkout, y la tienda
     pública apagada.
   - Lo que hace el dueño: los "Detalles comerciales" (nombre completo y dirección), "Cambiar a modo en vivo",
     la verificación de identidad y la cuenta de pago.
5. Modo real:
   - Creem revisa la cuenta (*Cambiar a modo en vivo*: datos del negocio y verificación de identidad).
   - El dueño configura la cuenta de pago.
   - Se repiten en modo real los productos, la llave y el webhook, se cambian las 6 variables y se hace una compra
     real pequeña con su reembolso.
   - Cambiarle el nombre a la tienda en Creem: hoy es "https://mylifetime.cc/" y así sale en la página de pago.
   - **Mientras la tienda esté en prueba, cualquiera con la tarjeta 4111 (es pública) saca tiempo gratis**: no
     dejarla así más de lo necesario.

**Ojo**: si Creem cambia la forma de sus eventos, el log `creem <evento> → <acción>` lo muestra; un evento que no
entiende queda `ignored` y no acredita nada. Un reembolso dice cuántas compras deshizo (`→ refunded (1 compra
deshecha)`): si dice 0, no encontró lo que había acreditado.

### 3. Idiomas: lo que falta

Hecho: inglés y español (inglés por defecto; selector en Ajustes). Cómo se agrega texto: el fijo del HTML va
en inglés en `index.html` con `data-i18n="clave"` y en español en `ES_STATIC`; el dinámico va en `EN` y `ES`
de `public/i18n.js` y se usa con `T('clave')`. `test/i18n.test.js` falla si falta una clave en algún idioma.

- **Salario mínimo por país**: hecho para Colombia y Estados Unidos (`wageFor` en `economy.js`; `MIN_WAGE_MONTHLY` y
  `MIN_WAGE_US_HOURLY`). Falta agregar más países (cada uno con su salario y su fuente) cuando el dueño lo pida.

### 4. Antes de la promoción

- Poner un **tope de gasto** en la consola de Anthropic (cada "Mi día" llama al modelo).
- Configurar `ADMIN_TOKEN` en Railway y revisar `/admin` (cuentas repetidas por teléfono o red).
- Límites actuales: 20 relojes nuevos por hora por red, 7 charlas de "Mi día" por persona y fecha y 240 peticiones
  por minuto. Si hay abuso, considerar un captcha invisible (p. ej. Turnstile), ajustando la CSP.
- Gancho: *"si no haces nada con tu vida, tu reloj llega a cero"*.

## Decisiones pendientes del dueño

- ~~Procesador de pagos~~: Creem (2026-11-16; Stripe no abre en Colombia y Lemon Squeezy cerró a tiendas nuevas).
  Falta que Creem apruebe la cuenta para modo real.
- ~~Precios~~: Plus 4,99/mes, +4 días 2,99, Revivir 4,99, Regalo 4,99 (2026-11-16). Pendiente: mejorar el modelo de negocio.
- ¿Salario de EE. UU.? Hoy US$14/h (lo dijo el dueño); el mínimo federal es US$7,25 y varía por estado.
- Límites propuestos: dinero 7 días/semana en tu palabra y 30 para todos; juicio con 3 acusadores, 3 votos de quórum y 2/3 para culpable.

## Mercado (investigado el 2026-11-13)

No encontramos ninguna app que junte las tres cosas de Tiempo: el reloj como saldo que se acaba, una IA
que juzga con pruebas y tiempo que se regala entre personas.

- **Relojes de vida**: [Death Clock](https://techcrunch.com/2024/12/01/death-clock-app-predicts-the-date-of-your-death)
  (una IA predice la fecha de tu muerte; viral a finales de 2024, unas 125.000 descargas en semanas, pero
  no se puede ganar tiempo), [Left](https://apps.apple.com/us/app/left-widgets-for-time-left/id6740155884)
  y TimeStore (tu vida en semanas + hábitos).
- **Ganar y gastar tiempo**: MinuteBank (monedas por concentrarte, con "deuda de tiempo") y
  [TimeWallet](https://apps.apple.com/app/id6743134922) (10 min de concentración = 5 min de redes).
- **Hábitos con prueba**: [Forfeit](https://www.ycombinator.com/launches/IAg-forfeit-app-complete-your-habits-or-we-take-your-money)
  (Y Combinator; pierdes dinero si no cumples, con prueba en foto o video; dicen tener más de 20.000
  usuarios) y SnapHabit (una IA verifica la foto, sin nada en juego).
- **Conclusión**: el hueco está libre. Lo de la muerte se vuelve viral y la gente sí paga por
  comprometerse.
