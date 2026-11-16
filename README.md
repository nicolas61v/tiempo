# Tiempo

Un reloj de vida. Empiezas con **1 semana**. Vivir cuesta un día por día. Cada día le cuentas al **Guardián** (IA) qué hiciste y él decide qué te suma y qué te resta. Si llega a cero, se acabó: solo queda renacer.

## La economía

Un solo axioma: **1 día de vida = 1 día de salario mínimo del país donde vives** (salario mínimo mensual ÷ 30). Por ahora hay dos:

- **Colombia**: SMMLV 2026 $1.750.905 ÷ 30 = **$58.364** (unos US$14,59).
- **Estados Unidos**: US$14 la hora × 40 h × 52 semanas ÷ 12 = US$2.426,67 al mes ÷ 30 = **US$80,89**.
- Los demás países usan, por ahora, el de Colombia.

Todo está en `public/economy.js` (`wageFor`), que comparten el servidor y la app.

**Moneda**: cada quien ve y escribe la plata en **COP** o **USD** (por defecto según su país: Colombia en pesos, el resto en dólares; se cambia en Ajustes). Por dentro todo se guarda en pesos y se convierte con `USD_COP` (4.000): la moneda no cambia cuánto vale tu día, eso lo decide tu país.

| Categoría | Conversión | Prueba |
|---|---|---|
| Dinero | $ ÷ 58.364 = días | Tu palabra (botón Dinero) |
| Inversión en ti | la mitad del dinero | Tu palabra |
| Gasto (antojos, impulso) | $ ÷ 58.364 = días que pierdes | Tu palabra |
| Aprendizaje | 1 h → 2 h (máx. 8 h/día) | Foto, la revisa el Guardián |
| Salud | 1 h → 3 h (máx. 2 h/día) | Foto, la revisa el Guardián |
| Proyecto | 1 h → 1 h (máx. 10 h/día) | El Guardián decide |

Lo que no encaja (descanso, ocio, redes…) no suma ni resta: ese tiempo ya se fue con el reloj.

**Límites para que un día sea creíble** (`MONEY` y `HOURS_PER_DAY` en `public/economy.js`; el servidor los vuelve a aplicar aunque la IA se equivoque):

- **Horas**: estudio + ejercicio + proyecto suman máximo **16 h en 24 h** (además del tope de cada uno).
- **Dinero en tu palabra**: hasta **7 días de vida por semana** (ingreso + inversión). Para más, se cuenta en "Mi día" con una prueba del pago (captura, extracto, factura).
- **Tope para todos**: el dinero suma máximo **30 días de vida por semana**, con o sin prueba.
- **Confianza**: cuando el Guardián aprueba con comprobante un ingreso grande (≥ 7 días de vida), desde ahí le cree en su palabra hasta el tope. Un jurado que lo declare culpable se lo quita.

## Cómo funciona

- **El servidor guarda una fecha**: cuándo se agota tu tiempo. El teléfono hace la cuenta regresiva.
- **Mi día**: escribes lo que hiciste y subes fotos. El Guardián (Claude Haiku 5.5) devuelve un veredicto por actividad. Tienes **7 charlas por día** (por fecha en la hora del teléfono: se renuevan a medianoche) y en cada una puedes **replicar 2 veces**; luego aceptas. La IA solo clasifica: el tiempo lo calcula la fórmula en el servidor. Las fotos se borran al cerrar el día; se guarda solo su huella, para que una misma foto no sirva dos veces.
- **El Guardián juzga si es humanamente posible**: recibe del servidor lo que ya contaste en las últimas 24 h, cuánto dinero te cabe en tu palabra, si tus ingresos están verificados y tus ingresos de los últimos 30 días. "9 h de gym", "corrí 100 km" o "aprendí 10 cálculos" se ajustan o se rechazan; un salto raro de ingresos (como 1.000 dólares de un día para otro) recibe preguntas y una petición de comprobante. Si hablas en dólares, los convierte a pesos (`USD_COP`).
- **Ranking** (se entra por elección, con nombre): *Esta semana* (tiempo ganado haciendo cosas en 7 días, menos gastos) y *Más tiempo* (lo que le queda en el reloj sin lo comprado). Ligas por tiempo restante: Bronce, Plata (2 sem), Oro (1 mes), Platino (3 meses), Diamante (6 meses), Inmortal (1 año). Lo comprado y lo recibido de otros nunca cuenta. Tocando a alguien se ve **qué hace y de dónde sale su tiempo** (sus actividades de 30 días, con o sin prueba).
- **Perfil**: al registrarse, nombre (opcional), **país (obligatorio)** y *¿a qué te dedicas?* (opcional, pero la app le dice que le conviene: el Guardián y los jurados lo tienen en cuenta). Quien venía de antes elige su país desde un aviso en la pantalla. El perfil lo revisa el Guardián antes de publicarlo.
- **Faltas por contenido sexual**: todo lo que se sube (fotos de "Mi día", pruebas de un juicio, el perfil, las acusaciones) pasa por el Guardián. Contenido sexual explícito = falta inmediata: 1 día, luego 1 semana, 1 mes, 3 meses, 1 año. Nunca se borran (ni al renacer) y no hay piso. Otras cosas que no se pueden mostrar (insultos, datos personales, links) se rechazan sin castigo.
- **Juicios (2 días)**:
  - *Día 1, citación*: citar a juicio es una potestad que se gana **viviendo de verdad** (todas tus vidas, sin los ratos en cero): con 15 días vale 1, con 30 vale 2, con 90 vale 3. Va a juicio si la citación suma 3 (o 1 si ganó 2 semanas de vida en 7 días). Todos ven cuánta gente lo quiere a juicio y **lo que está en juego** (lo que ganó sin prueba en los últimos 7 días; si todo lo probó, no se le puede citar). Ese mismo día el citado debe **defenderse con pruebas** (1 a 3 fotos: el movimiento del banco, una factura): el Guardián las revisa y le cuenta al jurado qué muestran.
  - *Fin del día 1*: sin potestad suficiente, se archiva. Si se completó y no se defendió, es culpable. Si se defendió, pasa al día 2.
  - *Día 2, veredicto secreto*: votan culpable o inocente los jugadores con 3 días vividos (nadie de su teléfono o red, ni con quien se pasó tiempo; quienes lo citaron sí, para reconsiderar con las pruebas, que ve el jurado). Solo se ve cuánta gente ha votado. Al acabar el día se revelan los votos: culpable con 2/3 y al menos 3.
  - *Culpable*: pierde lo que estaba en juego (siempre le queda 1 h), que se reparte entre quienes votaron culpable (o entre quienes lo citaron, si no se defendió); pierde la confianza en sus ingresos y sale del ranking 30 días. *Inocente*: conserva lo que estaba en disputa y gana 1 día, igual que cada uno de los que votaron inocente. *Sin quórum*: libre. Después de cualquier juicio, nadie puede volver a juzgarlo en 14 días.
  - **El Guardián también cita a juicio**: si al juzgar un día ve algo serio (insiste con cosas imposibles, ingresos que no cuadran con su historia), lo cita y con eso basta; la gente se puede sumar. Solo cita a quien está en el ranking.
  - **Un voto por persona al día** (citar o decidir un veredicto), contra el spam. Los premios del jurado no cuentan en el ranking. Las fotos de las pruebas se borran al cerrar el juicio.
- **Tienda (Creem)**: **Plus** US$4,99/mes (15 charlas al día, 3 réplicas, Guardián Sonnet, 1 Revivir gratis al mes; nunca da tiempo), **Revivir** US$4,99 (en cero: vuelves con 1 día conservando vida, récord e historial), **+4 días** US$2,99 (una compra por semana, nunca en la última hora) y **Regalo de 1 semana** US$4,99 (código + QR; cada persona recibe máximo uno comprado por semana). Precios en `PRODUCTS` de `server/payments.js`.
- **Transferir**: creas un código de 6 letras + QR por X tiempo. El tiempo sale de tu reloj al instante; quien lo escanea desde la app (Transferir → Recibir → Escanear QR) o escribe el código lo recibe. Si nadie lo reclama en 10 minutos, vuelve solo.
- **Alertas push** a 24 h, 1 h, 10 min y al llegar a cero, aunque la app esté cerrada.
- **Tu llave en QR**: Ajustes → Tu llave → Mostrar QR; en el otro dispositivo, Ajustes → escanear llave. Y si alguien la vio, **Cambiar tu llave** da una nueva para el mismo reloj.
- **Recordatorio de "Mi día"** (cada 6 h, 12 h —por defecto— o 24 h, o apagado): si en ese lapso no le cuentas nada al Guardián, te lo recuerda. Nunca de 22:00 a 8:00 en la hora de tu teléfono; al tocarlo se abre "Mi día".
- **Sin contraseñas**: al empezar eliges un nombre o apodo (opcional) y la app te muestra tu *llave*, tu identificador. Con ella abres el mismo reloj en otro dispositivo (Ajustes → Tu llave).
- **Inglés y español**: la app arranca en inglés y se cambia en Ajustes → Language (o con un link `?lang=es`, que queda guardado). El Guardián, los errores y las alertas push hablan el idioma de la app.
- PWA instalable; sin conexión muestra el último estado.
- **Panel `/admin`** (con `ADMIN_TOKEN`): cuentas repetidas por teléfono o por red, reinicios voluntarios y muertes por reloj. Cada teléfono tiene un identificador anónimo aleatorio y de la red solo se guarda una huella cifrada con un secreto del servidor: **la IP nunca se guarda**.
- **Las actualizaciones no tocan los relojes**: datos en el volumen, migraciones que solo agregan, copia de seguridad automática antes de migrar, y la app nunca borra una llave por su cuenta.

## Stack

Un solo servicio: Node 24 sin framework, SQLite integrado (`node:sqlite`) con migraciones versionadas, `web-push` y el SDK oficial de Anthropic. Frontend vanilla sin build; la fuente Inter y el generador de QR se sirven desde el propio servidor.

```
server/   index.js (HTTP + API) · store.js (SQLite) · store-pay.js (compras) · store-social.js (ranking y juicios)
          payments.js (Creem) · judge.js (Guardián IA) · push.js · static.js
public/   index.html · app.js · i18n.js (textos en/es) · clock.js · economy.js · styles.css · sw.js · vendor/ · fonts/
test/     store.test.js · pay.test.js · social.test.js · i18n.test.js · scan.test.js
```

## Local

```bash
npm install
npm run dev      # http://localhost:3000 (se recarga al editar)
npm test
```

"Mi día" necesita `ANTHROPIC_API_KEY`. Sin ella, el resto de la app funciona y el Guardián responde que no está configurado.

## Railway

1. Sube el repo a GitHub. En Railway: **New Project → Deploy from GitHub repo**. Usa el `Dockerfile` y `railway.json` incluidos.
2. **Settings → Volumes → Add Volume**, con mount path `/data`. Sin volumen, los datos se borran en cada deploy.
3. **Variables**: agrega `ANTHROPIC_API_KEY`.
4. **Settings → Networking → Generate Domain**.

No actives *Serverless / App Sleeping*: el servidor tiene que estar despierto para mandar alertas, devolver códigos vencidos y cerrar juicios.

### Pagos con Creem (lo único que hay que hacer)

[Creem](https://www.creem.io) es el *comerciante registrado*: cobra con tarjeta, maneja los impuestos de cada país y te paga por banco o en USDC. Acepta personas naturales de Colombia, sin empresa (Stripe no abre en Colombia y Lemon Squeezy ya no acepta tiendas nuevas). Empieza en **modo de prueba**: interruptor *Test Mode* abajo a la izquierda del panel. Prueba y real son mundos aparte: cada uno tiene sus propios productos, llave y webhook.

1. **Productos**: *Products → Create product* y crea 4, en **USD**, con estos nombres y precios (la app avisa en los logs si no cuadran):
   - **Tiempo Plus**: *Subscription* (recurrente), cada mes, US$4,99.
   - **+4 días de vida**: *One-time*, US$2,99.
   - **Regalo: 1 semana de vida**: *One-time*, US$4,99.
   - **Revivir**: *One-time*, US$4,99.

   Copia el id de cada uno (`prod_…`) a Railway → *Variables*: `CREEM_PRODUCT_PLUS`, `CREEM_PRODUCT_DIA`, `CREEM_PRODUCT_REGALO` y `CREEM_PRODUCT_REVIVIR`.
2. **Llave de la API**: *Developers → API keys* → copia la llave → Railway → `CREEM_API_KEY`. La de prueba empieza por `creem_test_` y la app usa sola la API de prueba.
3. **Webhook**: *Developers → Webhooks → Add*:
   - URL: `https://app.mylifetime.cc/api/creem/webhook`
   - Eventos: todos, o al menos `checkout.completed`, `subscription.active`, `subscription.paid`, `subscription.update`, `subscription.scheduled_cancel`, `subscription.canceled`, `subscription.expired`, `subscription.paused`, `subscription.unpaid`, `subscription.past_due`, `refund.created` y `dispute.created`.
   - Copia el *secret* del webhook a Railway → `CREEM_WEBHOOK_SECRET`.
4. Railway redespliega solo. En los logs debe salir `pagos con Creem listos (modo de prueba)`. Si algo no cuadra (un producto que no existe, Plus que no es mensual, un precio o una moneda distinta), sale un `⚠ Creem: …` que dice qué arreglar.
5. Prueba en la app (Tienda) con la tarjeta `4111 1111 1111 1111`, cualquier fecha futura y cualquier CVC. La app muestra un aviso de "modo de prueba" mientras la tienda esté en pruebas.
6. Para cobrar de verdad: Creem revisa la cuenta (1 a 3 días hábiles; pide dominio propio, términos, privacidad, precios visibles y correo de soporte: `mylifetime.cc` ya los tiene). Luego configura la cuenta de pago (*Balance → Payout Account*), apaga *Test Mode* y repite 1, 2 y 3 en modo real.

Seguridad: el tiempo y el Plus se acreditan solo por el webhook con firma verificada (nunca por lo que diga el navegador; al volver del pago la app solo espera a que llegue), y un aviso repetido no acredita dos veces. Lo que se entrega sale del producto pagado, no de los metadatos del checkout. Un reembolso completo (o un contracargo) descuenta lo acreditado y, si era Plus, lo termina; para reembolsar un mes de Plus, cancela también la suscripción en Creem.

| Variable | Por defecto | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Activa al Guardián |
| `ADMIN_TOKEN` | — | Clave del panel `/admin` (sin ella, el panel está apagado) |
| `CREEM_API_KEY` | — | Llave de la API de Creem (de prueba `creem_test_…` o real) |
| `CREEM_WEBHOOK_SECRET` | — | El *secret* del webhook `/api/creem/webhook` |
| `CREEM_PRODUCT_PLUS` · `_DIA` · `_REGALO` · `_REVIVIR` | — | Id (`prod_…`) de cada producto. Sin estas 6, la tienda queda apagada |
| `CREEM_TEST_MODE` | según la llave | `1` o `0` para forzar prueba o real |
| `PUBLIC_URL` | `https://<RAILWAY_PUBLIC_DOMAIN>` | A dónde vuelve alguien tras pagar si el navegador no dice de dónde salió (casi nunca hace falta) |
| `JUDGE_MODEL` | `claude-haiku-5-5` | Modelo del Guardián |
| `JUDGE_MODEL_PLUS` | `claude-sonnet-5-5` | Modelo del Guardián para quien tiene Plus (con respaldo automático si declina) |
| `USD_COP` | `4000` | Pesos por dólar: quien usa la app en USD ve y escribe en dólares, y el Guardián convierte |
| `MIN_WAGE_MONTHLY` | `1750905` | Salario mínimo mensual de Colombia, en pesos (actualízalo cada año) |
| `MIN_WAGE_US_HOURLY` | `14` | Salario mínimo por hora en Estados Unidos, en dólares (el federal es US$7,25; muchos estados pagan US$14–17) |
| `INITIAL_SECONDS` | `604800` | Tiempo con el que naces (1 semana) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto | Se generan una vez y se guardan en la base |
| `VAPID_SUBJECT` | `https://<RAILWAY_PUBLIC_DOMAIN>` | Contacto para los servicios push |

## API

Todas las rutas usan `Authorization: Bearer <llave>`, salvo las marcadas. La app manda además `X-Lang: en|es`: los mensajes de error salen en ese idioma (sin el encabezado, en español) y queda guardado para las alertas push y el Guardián.

| Método | Ruta | |
|---|---|---|
| POST | `/api/session` | `{ nickname?, country, currency? }`: crea un reloj y devuelve `{ token, state }` (sin llave) |
| GET | `/api/state` | Estado actual |
| POST | `/api/me/key` | Llave nueva para el mismo reloj (la anterior deja de servir) |
| PATCH | `/api/me` | `{ nickname }`: nombre o apodo, máx. 32 caracteres · `{ remindEvery, tz }`: recordatorio (0, 21600, 43200 u 86400 s) |
| POST | `/api/tx` | `{ category, amount, note }`: solo categorías "en tu palabra" |
| DELETE | `/api/tx/:id` | Deshacer (máx. 5 min) |
| POST | `/api/day` | `{ text, images[] }`: abre "Mi día" y trae el veredicto |
| POST | `/api/day/:id/reply` | Réplica (máx. 2) |
| POST | `/api/day/:id/accept` · `/discard` | Cerrar el día |
| POST | `/api/transfer` | `{ seconds }`: crea código para regalar tiempo |
| POST | `/api/transfer/claim` | `{ code }`: recibir |
| GET · DELETE | `/api/transfer/:code` | Estado · cancelar y recuperar |
| POST | `/api/rebirth` | Renacer (`{ force: true }` si aún estás vivo) |
| GET | `/api/push/key` | Llave pública VAPID (sin llave) |
| GET | `/api/admin/stats` | Resumen anti-abuso, ventas y juicios (con `Authorization: Bearer <ADMIN_TOKEN>`) |
| PATCH | `/api/me` | `{ ranked }`: entrar o salir del ranking (necesita nombre) · `{ bio }`: a qué se dedica (lo revisa el Guardián) · `{ country }` · `{ currency: 'COP'\|'USD' }` |
| GET | `/api/rank?board=semana\|tiempo` | Tabla del ranking (top 100 + tu puesto) |
| GET | `/api/people/:id` | Perfil público: de dónde sale su tiempo y qué hace (30 días) |
| GET · POST | `/api/trials` | Juicios abiertos y cerrados · `{ target, reason, text }`: citar a juicio o sumarse a la citación (día 1; cuenta como el voto del día) |
| GET | `/api/trials/:id` | Un juicio: acusaciones (anónimas), defensa y pruebas |
| POST | `/api/trials/:id/defense` · `/vote` | `{ text, images[] }` (el citado, día 1, con 1 a 3 fotos de pruebas) · `{ vote: 'culpable'\|'inocente' }` (día 2, secreto) |
| GET | `/api/store` | Tienda: productos con precio y si se pueden comprar ya, tus compras y tus regalos |
| POST | `/api/checkout` | `{ product: 'plus'\|'dia'\|'regalo'\|'revivir' }` → `{ url }` de Creem |
| GET | `/api/checkout/:ck` | Estado de un pago al volver de Creem (`ck_…`, la referencia del checkout) |
| POST | `/api/plus/renewal` | `{ renews }`: cancelar o retomar la renovación de Plus |
| POST | `/api/revive` | Revivir gratis (Plus, una vez cada 30 días) |
| POST | `/api/creem/webhook` | Avisos de Creem (sin llave; con firma `creem-signature`) |
| POST · DELETE | `/api/push` | Suscribir o desuscribir alertas (`tz` opcional: zona horaria del teléfono) |
