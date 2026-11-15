# Tiempo: plan de trabajo

> Para quien retome el proyecto (persona o Claude). Lee **Reglas que no se rompen** antes de tocar nada.
> Actualizado: 2026-11-15.

## Qué es y qué ya existe

PWA móvil "Tiempo": un reloj de vida inspirado en *El precio del mañana*. Empiezas con 1 semana, vivir
cuesta 1 día por día y, si llega a cero, se acabó. **1 día de vida = 1 salario mínimo diario de Colombia**
(SMMLV 2026 $1.750.905 / 30 = $58.364).

- **Stack**: Node 24 sin framework, SQLite integrado (`node:sqlite`) con migraciones versionadas
  (`MIGRATIONS` en `server/store.js`, hoy v1–v11), `web-push` y el SDK de Anthropic. Frontend vanilla sin
  build en `public/`. Detalle en `README.md`.
- **Deploy**: push a `main` → Railway despliega solo. Volumen en `/data`. Producción:
  `tiempo-production-79dc57d3.up.railway.app`.
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
  - **En la rama `pagos-ranking` (sin publicar en `main`)**: pagos con Stripe, ranking con ligas y perfiles
    públicos, juicios del jurado, límites de dinero con confianza del Guardián y un Guardián que exige que el día
    sea humanamente posible. Detalle en la tarea 2 y en el `README.md`. Migraciones v10 y v11 (solo agregan).

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

### 1. Dominio propio y mudanza sin perder relojes (antes de promocionar)

El dueño va a comprar un dominio (piensa en `time.cc`; antes de pagar hay que verificar el precio real,
porque las palabras cortas en `.cc` suelen ser premium). **Hacerlo antes de la promoción**, para que la gente
nueva arranque en el dominio definitivo.

- Railway → Settings → Networking → Custom Domain + registro CNAME. Actualizar `VAPID_SUBJECT`.
- Los dos dominios sirven el mismo servidor y la misma base.
- En el dominio viejo: aviso "Nos mudamos" con un botón que abre `https://NUEVO/#k=<llave>`. El fragmento
  `#` no llega al servidor ni queda en los logs. En el nuevo, la app importa la llave; si ya tenía otra
  distinta, pregunta y guarda la anterior en `oldKeys`. Luego limpia la URL con `history.replaceState`.
- Las alertas push y la app instalada están atadas al dominio: pedir que reactiven alertas y reinstalen.
- **Listo cuando**: un reloj creado en el dominio viejo se abre en el nuevo con un toque y `expiresAt`
  idéntico. Probarlo de punta a punta con dos orígenes locales (`127.0.0.1` y `localhost`).

### 2. Pagos, ranking y juicios: hecho en la rama `pagos-ranking` (falta probarlo con Stripe y publicarlo)

Pedido del dueño (2026-11-15): Stripe en una rama aparte y "dejar todo listo para solo pegar la clave y el
webhook"; ranking para ver quién va ganando más tiempo y **qué hace cada uno**; un límite a lo que se gana por
dinero; un Guardián que no se trague días imposibles ("9 h de gym", "aprendí 10 cálculos") y que pregunte por
ingresos raros (1.000 USD de un día para otro), pero que confíe más en quien ya los probó; y juicios de los
jugadores contra quien sea sospechosamente rico en tiempo.

**Qué hay** (todo con pruebas en `test/pay.test.js`, `test/social.test.js` y `test/store.test.js`; 60 en total):

- **Stripe sin dependencias** (`server/payments.js`): checkout por redirección con `price_data` (no hay que crear
  productos en Stripe), webhook con firma HMAC verificada a mano, eventos de facturas en las dos formas de la API.
  Capa intercambiable: el resto de la app solo ve acciones (`paid`, `renewed`, `plus_ended`, `refunded`…).
  Al volver del pago, si el webhook no ha llegado, el servidor le pregunta a Stripe (servidor a servidor).
- **Productos** (precios en `PRODUCTS`): Plus US$2,99/mes · Revivir US$0,99 (1 día, conserva vida, récord e
  historial) · +1 día US$0,99 (uno por semana, nunca en la última hora) · Regalo de 1 semana US$3,99 (código + QR
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

1. El dueño pega `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` **de prueba** en Railway (pasos en el README).
2. Probar en producción con la tarjeta 4242: Plus, +1 día, regalo (reclamarlo desde otro reloj) y Revivir
   (con un reloj de prueba en cero). Un reembolso desde el panel de Stripe debe descontar el tiempo.
3. Probar "Mi día" con la API real: un día imposible, un ingreso grande sin prueba (debe pedir comprobante) y
   con prueba (debe dar confianza). Esto gasta tokens: no se probó contra la API en esta sesión.
4. Merge a `main` con la sonda de deploy (regla 2): la migración v10 solo agrega columnas y tablas.
5. Cuando todo esté bien, cambiar a las llaves `sk_live_` y su webhook.

**Ojo**: verificar que la cuenta de Stripe del dueño pueda cobrar desde su país (Stripe no abre cuentas de
vendedores en Colombia; las opciones son una empresa en un país soportado, p. ej. con Stripe Atlas).

### 3. Idiomas: lo que falta

Hecho: inglés y español (inglés por defecto; selector en Ajustes). Cómo se agrega texto: el fijo del HTML va
en inglés en `index.html` con `data-i18n="clave"` y en español en `ES_STATIC`; el dinámico va en `EN` y `ES`
de `public/i18n.js` y se usa con `T('clave')`. `test/i18n.test.js` falla si falta una clave en algún idioma.

- **Salario mínimo por país**: hoy es fijo de Colombia (`config.minWage`, meta `min-wage`). Con otros
  países, 1 día = salario mínimo diario de **su** país. El país se elige en Ajustes y se guarda en `users`
  (migración). Se cruza con el precio de los pagos: ¿USD único o por país? (decisión del dueño).
- La moneda sigue fija en COP (también en inglés, donde se ve como "$58,364"): cambia junto con el país.
  Mientras tanto, a quien use la app en inglés y cuente plata en dólares, el Guardián la toma como pesos.

### 4. Antes de la promoción

- Poner un **tope de gasto** en la consola de Anthropic (cada "Mi día" llama al modelo).
- Configurar `ADMIN_TOKEN` en Railway y revisar `/admin` (cuentas repetidas por teléfono o red).
- Límites actuales: 20 relojes nuevos por hora por red, 7 charlas de "Mi día" por persona y fecha y 240 peticiones
  por minuto. Si hay abuso, considerar un captcha invisible (p. ej. Turnstile), ajustando la CSP.
- Gancho: *"si no haces nada con tu vida, tu reloj llega a cero"*.

## Decisiones pendientes del dueño

- ~~Procesador de pagos~~: Stripe (decidido el 2026-11-15). Falta confirmar el país de la cuenta.
- Precios: los de `PRODUCTS` son una propuesta (Plus 2,99/mes, Revivir 0,99, +1 día 0,99, Regalo 3,99). ¿USD único o por país?
- Límites propuestos: dinero 7 días/semana en tu palabra y 30 para todos; juicio con 3 acusadores, 3 votos de quórum y 2/3 para culpable.
- Dominio definitivo.

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
