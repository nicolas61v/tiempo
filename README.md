# Tiempo

Un reloj de vida. Empiezas con **1 semana**. Vivir cuesta un día por día. Cada día le cuentas al **Guardián** (IA) qué hiciste y él decide qué te suma y qué te resta. Si llega a cero, se acabó: solo queda renacer.

## La economía

Un solo axioma: **1 día de vida = 1 salario mínimo diario** (SMMLV 2026 $1.750.905 ÷ 30 = $58.364). Todo está en `public/economy.js`, que comparten el servidor y la app.

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
- **Juicios del jurado**: si alguien parece sospechosamente rico en tiempo, los del ranking piden un juicio. Se abre con 3 acusadores de teléfonos distintos (o 1 si ganó 2 semanas de vida en 7 días). El acusado tiene 24 h para defenderse y luego vota un jurado de jugadores durante 48 h (nadie de su teléfono o red, ni con quien se pasó tiempo, ni sus acusadores; relojes de 3 días o más). Culpable con 2/3 y mínimo 3 votos: pierde lo ganado **sin prueba** la semana antes (siempre le queda 1 h), pierde la confianza en sus ingresos y sale del ranking 30 días. Si no, queda libre y nadie puede juzgarlo en 14 días.
- **Tienda (Stripe)**: **Plus** US$2,99/mes (15 charlas al día, 3 réplicas, Guardián Sonnet, 1 Revivir gratis al mes; nunca da tiempo), **Revivir** US$0,99 (en cero: vuelves con 1 día conservando vida, récord e historial), **+1 día** US$0,99 (máximo uno por semana, nunca en la última hora) y **Regalo de 1 semana** US$3,99 (código + QR; cada persona recibe máximo uno comprado por semana). Precios en `PRODUCTS` de `server/payments.js`.
- **Transferir**: creas un código de 6 letras + QR por X tiempo. El tiempo sale de tu reloj al instante; quien lo escanea desde la app (Transferir → Recibir → Escanear QR) o escribe el código lo recibe. Si nadie lo reclama en 10 minutos, vuelve solo.
- **Alertas push** a 24 h, 1 h, 10 min y al llegar a cero, aunque la app esté cerrada.
- **Tu llave en QR**: Ajustes → Tu llave → Mostrar QR; en el otro dispositivo, Ajustes → escanear llave. Y si alguien la vio, **Cambiar tu llave** da una nueva para el mismo reloj.
- **Recordatorio de "Mi día"** (cada 6 h, 12 h —por defecto— o 24 h, o apagado): si en ese lapso no le cuentas nada al Guardián, te lo recuerda. Nunca de 22:00 a 8:00 en la hora de tu teléfono; al tocarlo se abre "Mi día".
- **Sin contraseñas**: al empezar eliges un nombre o apodo (opcional) y la app te muestra tu *llave*, tu identificador. Con ella abres el mismo reloj en otro dispositivo (Ajustes → Tu llave).
- **Inglés y español**: la app arranca en inglés y se cambia en Ajustes → Language. El Guardián, los errores y las alertas push hablan el idioma de la app.
- PWA instalable; sin conexión muestra el último estado.
- **Panel `/admin`** (con `ADMIN_TOKEN`): cuentas repetidas por teléfono o por red, reinicios voluntarios y muertes por reloj. Cada teléfono tiene un identificador anónimo aleatorio y de la red solo se guarda una huella cifrada con un secreto del servidor: **la IP nunca se guarda**.
- **Las actualizaciones no tocan los relojes**: datos en el volumen, migraciones que solo agregan, copia de seguridad automática antes de migrar, y la app nunca borra una llave por su cuenta.

## Stack

Un solo servicio: Node 24 sin framework, SQLite integrado (`node:sqlite`) con migraciones versionadas, `web-push` y el SDK oficial de Anthropic. Frontend vanilla sin build; la fuente Inter y el generador de QR se sirven desde el propio servidor.

```
server/   index.js (HTTP + API) · store.js (SQLite) · store-pay.js (compras) · store-social.js (ranking y juicios)
          payments.js (Stripe) · judge.js (Guardián IA) · push.js · static.js
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

### Pagos con Stripe (lo único que hay que hacer)

Los productos y precios ya están en el código: **no hay que crear productos en Stripe**. Empieza en **modo de prueba** (interruptor *Test mode* del panel de Stripe).

1. **Clave secreta**: Stripe → *Developers → API keys* → copia la *Secret key* (`sk_test_…`). En Railway → *Variables* → `STRIPE_SECRET_KEY`.
2. **Webhook**: Stripe → *Developers → Webhooks → Add endpoint*:
   - URL: `https://<tu-dominio>/api/stripe/webhook`
   - Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`
   - Copia el *Signing secret* (`whsec_…`) → Railway → `STRIPE_WEBHOOK_SECRET`.
3. Railway redespliega solo. En los logs debe salir `pagos con Stripe listos (modo de prueba)`.
4. Prueba en la app (Tienda) con la tarjeta `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC. La app muestra un aviso de "modo de prueba" mientras la clave sea `sk_test_`.
5. Para cobrar de verdad: repite 1 y 2 con el panel en modo real (`sk_live_…` y un webhook nuevo con su propio `whsec_…`).

Seguridad: el tiempo y el Plus se acreditan solo por el webhook con firma verificada o porque el servidor le pregunta a Stripe directamente al volver del pago (nunca por lo que diga el navegador), y un aviso repetido no acredita dos veces. Un reembolso completo o un contracargo descuentan lo acreditado y cancelan el Plus. Para reembolsar un mes de Plus, cancela también la suscripción en Stripe.

| Variable | Por defecto | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Activa al Guardián |
| `ADMIN_TOKEN` | — | Clave del panel `/admin` (sin ella, el panel está apagado) |
| `STRIPE_SECRET_KEY` | — | Activa la tienda (`sk_test_…` en pruebas, `sk_live_…` real) |
| `STRIPE_WEBHOOK_SECRET` | — | Firma del webhook `/api/stripe/webhook` (`whsec_…`) |
| `PUBLIC_URL` | `https://<RAILWAY_PUBLIC_DOMAIN>` | A dónde vuelve alguien tras pagar si el navegador no dice de dónde salió (casi nunca hace falta) |
| `JUDGE_MODEL` | `claude-haiku-5-5` | Modelo del Guardián |
| `JUDGE_MODEL_PLUS` | `claude-sonnet-5-5` | Modelo del Guardián para quien tiene Plus (con respaldo automático si declina) |
| `USD_COP` | `4000` | Pesos por dólar, para cuando alguien le cuenta al Guardián en dólares |
| `MIN_WAGE_MONTHLY` | `1750905` | Salario mínimo mensual (actualízalo cada año) |
| `INITIAL_SECONDS` | `604800` | Tiempo con el que naces (1 semana) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto | Se generan una vez y se guardan en la base |
| `VAPID_SUBJECT` | `https://<RAILWAY_PUBLIC_DOMAIN>` | Contacto para los servicios push |

## API

Todas las rutas usan `Authorization: Bearer <llave>`, salvo las marcadas. La app manda además `X-Lang: en|es`: los mensajes de error salen en ese idioma (sin el encabezado, en español) y queda guardado para las alertas push y el Guardián.

| Método | Ruta | |
|---|---|---|
| POST | `/api/session` | `{ nickname? }`: crea un reloj y devuelve `{ token, state }` (sin llave) |
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
| PATCH | `/api/me` | `{ ranked: true\|false }`: entrar o salir del ranking (necesita nombre) |
| GET | `/api/rank?board=semana\|tiempo` | Tabla del ranking (top 100 + tu puesto) |
| GET | `/api/people/:id` | Perfil público: de dónde sale su tiempo y qué hace (30 días) |
| GET · POST | `/api/trials` | Juicios abiertos y cerrados · `{ target, reason, text }`: pedir un juicio |
| GET | `/api/trials/:id` | Un juicio: acusaciones (anónimas), defensa y pruebas |
| POST | `/api/trials/:id/defense` · `/vote` | `{ text }` (el acusado, 24 h) · `{ vote: 'culpable'\|'inocente' }` |
| GET | `/api/store` | Tienda: productos con precio y si se pueden comprar ya, tus compras y tus regalos |
| POST | `/api/checkout` | `{ product: 'plus'\|'dia'\|'regalo'\|'revivir' }` → `{ url }` de Stripe |
| GET | `/api/checkout/:cs_id` | Estado de un pago al volver de Stripe |
| POST | `/api/plus/renewal` | `{ renews }`: cancelar o retomar la renovación de Plus |
| POST | `/api/revive` | Revivir gratis (Plus, una vez cada 30 días) |
| POST | `/api/stripe/webhook` | Avisos de Stripe (sin llave; con firma `Stripe-Signature`) |
| POST · DELETE | `/api/push` | Suscribir o desuscribir alertas (`tz` opcional: zona horaria del teléfono) |
