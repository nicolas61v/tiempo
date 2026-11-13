# Tiempo: plan de trabajo

> Para quien retome el proyecto (persona o Claude). Lee **Reglas que no se rompen** antes de tocar nada.
> Actualizado: 2026-11-13.

## Qué es y qué ya existe

PWA móvil "Tiempo": un reloj de vida inspirado en *El precio del mañana*. Empiezas con 1 semana, vivir
cuesta 1 día por día y, si llega a cero, se acabó. **1 día de vida = 1 salario mínimo diario de Colombia**
(SMMLV 2026 $1.750.905 / 30 = $58.364).

- **Stack**: Node 24 sin framework, SQLite integrado (`node:sqlite`) con migraciones versionadas
  (`MIGRATIONS` en `server/store.js`, hoy v1–v8), `web-push` y el SDK de Anthropic. Frontend vanilla sin
  build en `public/`. Detalle en `README.md`.
- **Deploy**: push a `main` → Railway despliega solo. Volumen en `/data`. Producción:
  `tiempo-production-79dc57d3.up.railway.app`.
- **Ya hecho**:
  - Reloj (años · meses · semanas · días · horas · min · seg) que se ajusta a cualquier ancho de pantalla.
  - **Mi día**: le cuentas al Guardián (Claude Haiku 5.5, `server/judge.js`; el dueño lo eligió así) qué
    hiciste, con fotos como prueba, y él decide qué suma. Máximo 5 al día.
  - **Dinero**: ingresos e inversión suman; gastos restan (en tu palabra).
  - **Transferir**: código de 6 letras + QR; escáner de QR dentro de la app (`public/scan.js`: lector
    nativo en Android, jsQR en iPhone). El historial dice "De Nico" / "Para Pipe".
  - **Llave**: identificador anónimo (no hay cuentas ni contraseña). QR de la llave para abrir el reloj en
    otro dispositivo, y "Cambiar tu llave" (`POST /api/me/key`).
  - Alertas push (24 h, 1 h, 10 min, cero) y recordatorio de "Mi día" (6/12/24 h, nunca de 22:00 a 8:00).
  - Anti-abuso (dispositivo anónimo + huella cifrada de red) y panel `/admin`.
  - La app se actualiza sola al volver a ella (si hay una hoja abierta, al cerrarla).

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

### 2. Pagos: Revivir + Plus

Pagos globales y anónimos para el usuario (el pago se ata a la llave, no a una cuenta; el procesador solo
pide un correo para el recibo). La app es web y no está en tiendas, así que **no** paga el 30 % a
Apple/Google ni usa compras dentro de la app.

**Procesador (decisión del dueño)**: hasta donde sabemos, Stripe no acepta vendedores de Colombia (hay que
verificarlo en stripe.com/global). Opciones: **Lemon Squeezy o Paddle** (vendedor oficial: cobran en todo el
mundo y manejan el IVA de cada país; mejor para empezar) o **Stripe Atlas** (LLC en Delaware, unos $500 USD
más costos anuales). Por eso: **una capa de proveedor intercambiable** en `server/payments.js`:

```js
createCheckout({ userId, product }) → { url }          // página de pago del proveedor (redirección, no iframe)
parseWebhook(req, rawBody) → { type: 'paid' | 'refunded', userId, product, ref } // verifica la firma
```

**Productos** (empezar por a y b):

- **a. Revivir** (pago único, ~US$1): con el reloj en cero (fase `dead`), en vez de "Renacer" desde cero
  revive conservando su número de vida, récord e historial. ¿Con cuánto tiempo? Propuesta: 1 día (lo decide
  el dueño).
- **b. Plus** (suscripción, ~US$3/mes): "Mi día" sin el límite de 5 (`DAYS_PER_24H` en `store.js`),
  Guardián con Sonnet en vez de Haiku (`JUDGE_MODEL`/`judge.js`), estadísticas de vidas, temas de color,
  exportar el historial.
- **c. Regalar tiempo comprado** (paquetes de 1 día o 1 semana) usando el flujo de transferencias
  (código + QR), lo que también trae usuarios nuevos.
- **d. (Opcional, con tope) comprar tiempo para uno mismo**: máximo 1 día por semana para que ganarlo
  haciendo cosas siga teniendo sentido. **Nunca** ofrecerlo en fase `critical` (última hora): eso es
  presionar con miedo.

**Técnico**:

- Migración nueva: tabla `purchases` (`id`, `user_id`, `provider`, `ref` UNIQUE, `product`, `amount`,
  `currency`, `status`, `created_at`) y `users.plus_until`. Con su prueba de que ningún reloj cambia.
- El tiempo o el Plus se acreditan **solo por un webhook con firma verificada**, nunca por la redirección
  del navegador. Idempotente por `ref`: un webhook repetido no acredita dos veces.
- Reembolso o contracargo: descontar lo acreditado y cancelar el Plus.
- Historial: categorías de sistema nuevas en `public/economy.js` (p. ej. `compra`, `revivir`).
- CSP: con redirección al checkout no hay que abrirla; si se usa un overlay (Lemon.js/Paddle.js), ajustar
  `script-src` y `frame-src` en `server/index.js`.
- Primero en **modo de prueba** (claves de prueba en las Variables de Railway).
- Pruebas: webhook duplicado, firma inválida (400), reembolso que descuenta, Revivir solo en fase `dead`,
  Plus vencido que vuelve al límite.

### 3. Idiomas (acordado con el dueño)

- Sacar los textos de `public/index.html` y `public/app.js` a diccionarios (`es` y `en` primero).
  Detectar por `navigator.language`, con selector en Ajustes.
- El Guardián responde en el idioma del usuario (pasar el idioma a `judge.js`).
- **Salario mínimo por país**: hoy es fijo de Colombia (`config.minWage`, meta `min-wage`). Con otros
  países, 1 día = salario mínimo diario de **su** país. El país se elige en Ajustes y se guarda en `users`
  (migración). Se cruza con el precio de los pagos: ¿USD único o por país? (decisión del dueño).
- Los formatos `Intl` hoy están fijos en `es` / `es-CO` / COP: parametrizarlos.

### 4. Antes de la promoción

- Poner un **tope de gasto** en la consola de Anthropic (cada "Mi día" llama al modelo).
- Configurar `ADMIN_TOKEN` en Railway y revisar `/admin` (cuentas repetidas por teléfono o red).
- Límites actuales: 20 relojes nuevos por hora por red, 5 "Mi día" por persona al día y 240 peticiones
  por minuto. Si hay abuso, considerar un captcha invisible (p. ej. Turnstile), ajustando la CSP.
- Gancho: *"si no haces nada con tu vida, tu reloj llega a cero"*.

## Decisiones pendientes del dueño

- Procesador de pagos: Lemon Squeezy o Paddle vs. Stripe Atlas.
- Precios de Revivir, Plus y paquetes; ¿USD único o por país?
- Revivir: ¿con cuánto tiempo?
- ¿Se puede comprar tiempo para uno mismo (con tope) o no?
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
