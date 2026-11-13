# Tiempo

Un reloj de vida. Empiezas con **1 semana**. Vivir cuesta un día por día. Cada día le cuentas al **Guardián** (IA) qué hiciste y él decide qué te suma y qué te resta. Si llega a cero, se acabó: solo queda renacer.

## La economía

Un solo axioma: **1 día de vida = 1 salario mínimo diario** (SMMLV 2026 $1.750.905 ÷ 30 = $58.364). Todo está en `public/economy.js`, que comparten el servidor y la app.

| Categoría | Conversión | Prueba |
|---|---|---|
| Dinero | $ ÷ 58.364 = días | Tu palabra (botón Plata) |
| Inversión en ti | la mitad del dinero | Tu palabra |
| Gasto (antojos, impulso) | $ ÷ 58.364 = días que pierdes | Tu palabra |
| Aprendizaje | 1 h → 2 h (máx. 8 h/día) | Foto, la revisa el Guardián |
| Salud | 1 h → 3 h (máx. 2 h/día) | Foto, la revisa el Guardián |
| Proyecto | 1 h → 1 h (máx. 10 h/día) | El Guardián decide |

Lo que no encaja (descanso, ocio, redes…) no suma ni resta: ese tiempo ya se fue con el reloj.

## Cómo funciona

- **El servidor guarda una fecha**: cuándo se agota tu tiempo. El teléfono hace la cuenta regresiva.
- **Mi día**: escribes lo que hiciste y subes fotos. El Guardián (Claude Haiku 5.5) devuelve un veredicto por actividad. Puedes **replicar 2 veces**; luego aceptas. La IA solo clasifica: el tiempo lo calcula la fórmula en el servidor. Las fotos se borran al cerrar el día; se guarda solo su huella, para que una misma foto no sirva dos veces.
- **Compartir**: creas un código de 6 letras + QR por X tiempo. El tiempo sale de tu reloj al instante; quien escanea el QR (con la cámara del celular) o escribe el código lo recibe. Si nadie lo reclama en 10 minutos, vuelve solo.
- **Alertas push** a 24 h, 1 h, 10 min y al llegar a cero, aunque la app esté cerrada.
- **Sin contraseñas**: al empezar eliges un nombre o apodo (opcional) y la app te muestra tu *llave*, tu identificador. Con ella abres el mismo reloj en otro dispositivo (Ajustes → Tu llave).
- PWA instalable; sin conexión muestra el último estado.

## Stack

Un solo servicio: Node 24 sin framework, SQLite integrado (`node:sqlite`) con migraciones versionadas, `web-push` y el SDK oficial de Anthropic. Frontend vanilla sin build; la fuente Inter y el generador de QR se sirven desde el propio servidor.

```
server/   index.js (HTTP + API) · store.js (SQLite) · judge.js (Guardián IA) · push.js · static.js
public/   index.html · app.js · clock.js · economy.js · styles.css · sw.js · vendor/ · fonts/
test/     store.test.js
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

No actives *Serverless / App Sleeping*: el servidor tiene que estar despierto para mandar alertas y devolver códigos vencidos.

| Variable | Por defecto | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Activa al Guardián |
| `JUDGE_MODEL` | `claude-haiku-5-5` | Modelo del Guardián |
| `MIN_WAGE_MONTHLY` | `1750905` | Salario mínimo mensual (actualízalo cada año) |
| `INITIAL_SECONDS` | `604800` | Tiempo con el que naces (1 semana) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto | Se generan una vez y se guardan en la base |
| `VAPID_SUBJECT` | `https://<RAILWAY_PUBLIC_DOMAIN>` | Contacto para los servicios push |

## API

Todas las rutas usan `Authorization: Bearer <llave>`, salvo las marcadas.

| Método | Ruta | |
|---|---|---|
| POST | `/api/session` | `{ nickname? }`: crea un reloj y devuelve `{ token, state }` (sin llave) |
| GET | `/api/state` | Estado actual |
| PATCH | `/api/me` | `{ nickname }`: nombre o apodo, máx. 32 caracteres |
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
| POST · DELETE | `/api/push` | Suscribir o desuscribir alertas |
