# Estado Buffer Commit (parado el mié 28-oct-2026, ventana D1)

Rama `buffer` en `C:\Users\anton\repos\tablecast-buffer` (worktree de `tastecraft-open`, desde `876df62`, etiqueta local `nebius-submission`). **No se ha hecho push** (no antes del vie 30-oct 18:00 Madrid). El checkout `tastecraft-open` y su deploy no se han tocado. Lista de lo nuevo con commits: `BUFFER_CHANGES.md`.

## Qué está hecho y probado
60 tests nuevos (`tests/buffer/`), todos en verde; suite completa: 266 pasan, 5 saltados (los 206 + 5 de antes siguen igual). `typecheck` y `eslint` limpios.

| Pieza | Fichero | Tests |
|---|---|---|
| OAuth PKCE S256, estado sellado en cookie HttpOnly, un solo dueño del refresh rotatorio, 401/desconectado a reconectar | `src/lib/buffer/oauth.ts`, `seal.ts`, `config.ts`, `session.ts` | 15 (contra un mock local de auth.buffer.com que verifica PKCE, códigos de un solo uso y revoca al reusar un refresh) |
| Cliente GraphQL tipado: organizaciones, canales con zona horaria, createPost, editPost, deletePost, posts, dailyPostingLimits, createTag, tags; cabeceras RateLimit, 429 con Retry-After, caché | `src/lib/buffer/client.ts` | 10 |
| Escritor sin modelo: un post por momento, evento y plato no cubierto; hora local exacta, `why_now` con cita y fuente, texto por red; guarda de fechas | `src/lib/post-writer.ts` | 21 (3 planes grabados: Gjelina, Katz, Casa Lucio) |
| Imagen pública firmada con HMAC, PNG dibujado en servidor | `src/lib/post-image.ts`, `src/app/api/post-image/route.tsx` | 4 + comprobado a mano con `next dev` (PNG 1080x1080, firma falsa da 404, cabecera immutable) |
| Programar en Buffer (borrador por defecto), etiquetas, sin duplicados, límite diario | `src/lib/schedule.ts` | 6 |
| La cola sigue al tiempo: diff de previsión/eventos, propuestas `editPost`, solo se aplican con visto bueno | `src/lib/replan.ts` | 4 (incluye el cambio de hora de EE. UU. del 1-nov) |
| Rutas | `/api/buffer/login`, `callback`, `session` (GET/DELETE), `schedule` (GET previsualiza, POST crea) | probadas de punta a punta con `next dev` contra el mock: login, PKCE, callback, cookie, canales, 10 borradores creados |
| CI (typecheck, lint, tests) | `.github/workflows/ci.yml` | no ha corrido aún (no hay push) |

Importante: nada se ha probado contra el Buffer real todavía (no hay cliente de app). Los "fixtures" son respuestas con la forma de la documentación pública, no grabaciones reales. El primer run real debe grabar los reales.

## La API real frente al PLAN.md
Detalle en `docs/BUFFER_API_NOTES.md`. Lo que cambia:
1. `createPost` exige `assets` y `needsApproval` (no nulos) y metadatos por servicio (Instagram `{type: post, shouldShareToFeed: true}`, Facebook `{type: post}`, Google `google: {type: whats_new}`); sin ellos falla la validación.
2. Google Business sí está soportado (`googlebusiness`).
3. Los borradores (`saveToDraft`) no comprueban límites diarios; el código solo consulta `dailyPostingLimits` al programar de verdad.
4. Las etiquetas son una por motivo (lluvia, sol, evento, plato), no por día, por el límite de etiquetas del plan. `createTag` y `tagsV2` son experimentales.
5. No usamos `ideas:write` por ahora (Ideas no está hecho); scopes: `account:read posts:read posts:write offline_access`.
6. Sin verificar en vivo: si un borrador mantiene su estado al editarlo con `mode: customScheduled`. El código manda `saveToDraft: true` al mover borradores.

## Lo que solo puede hacer Antón (miércoles 28)
1. Entra en https://publish.buffer.com/settings/api, pestaña **App Clients**, **New Client**.
2. Nombre: **Tablecast Week** (sin la palabra "Buffer", nada que parezca oficial). URL/política de privacidad: la de la app (p. ej. `https://tablecast-week.vercel.app`, cuando exista el proyecto de Vercel). Logo opcional.
3. Tipo: **privado** (confidencial). PKCE queda activo.
4. Scopes: `account:read`, `posts:read`, `posts:write`, `offline_access` (no marcar más).
5. Redirect URIs, exactas y en HTTPS: `https://localhost:3000/api/buffer/callback` y la de producción, p. ej. `https://tablecast-week.vercel.app/api/buffer/callback` (la que elijas al crear el proyecto de Vercel; hay que registrar la misma letra por letra).
6. Copia el client ID y pégalo (sin verlo en el chat):
   `powershell -ExecutionPolicy Bypass -File C:/Users/anton/OneDrive/anton/competiciones/_tools/pegar-clave.ps1 -Proyecto C:/Users/anton/repos/tablecast-buffer -Nombre BUFFER_CLIENT_ID`
   y lo mismo con el secret: `-Nombre BUFFER_CLIENT_SECRET`. Para `SESSION_SECRET` (32+ caracteres, p. ej. `openssl rand -hex 32` o 64 hex aleatorios) y `BUFFER_REDIRECT_URI` usa el mismo script o dímelo en el siguiente turno; `SESSION_SECRET` es un secreto: pégalo igual.
7. Para probar en local con HTTPS: `npx next dev --experimental-https` (certificado autofirmado, el navegador pedirá aceptarlo). Entra en `https://localhost:3000/api/buffer/login`.
8. Con el canal de pruebas de Bluesky ya conectado a tu Buffer: todo se crea con `saveToDraft: true`. No programar de verdad en redes reales.
9. Vercel: proyecto nuevo (no el de Nebius), con las mismas variables (ver `.env.example`) y `PUBLIC_ORIGIN` = su URL pública https. El formulario final y el Submit son tuyos (client ID sí va en el formulario, el secret nunca).

## Riesgos abiertos
- Cupo compartido de la app: 100 por 15 min y 250 al día para todos los jueces. Programar un plan a un canal cuesta unas 8 a 14 llamadas. Si un juez lo agota, el cliente dice cuánto esperar (no insiste).
- Refresh rotatorio con cookies en serverless: dos instancias pueden refrescar a la vez; mitigado por `/api/buffer/session` primero y llamadas de una en una desde la interfaz (aún no hay interfaz).
- Tamaño de la cookie de sesión: se trocea en 4 cookies de 3000 caracteres; si un token de Buffer es enorme fallaría con un error claro. Verlo con el token real.
- Cambiar `SESSION_SECRET`/`IMAGE_SIGNING_SECRET` rompe las imágenes de posts ya en cola.
- El texto de los posts viene de campos del plan (nombre del plato, precio, previsión, eventos listados). Los momentos sin plato ni evento salen con el texto del plan para el dueño y llevan un aviso en `issues`; mejorar con el modelo solo en ejecuciones en vivo y con tope diario.
- Idioma: el escritor produce inglés ("Heavy rain today"). Falta versión en español si el plan es Español.
- Los planes grabados son del 21-oct; "replay" los mueve en bloques de 7 días a la semana actual (la previsión que se cita es la grabada). Hay que etiquetarlo como repetición grabada en la interfaz.
- El segundo pronóstico de la prueba de "la cola sigue al tiempo" está editado a mano; falta grabar uno real (la previsión de un lunes frente a la del lunes anterior).

## Siguientes pasos (calendario del PLAN: enviable lun 2-nov, vídeo antes del mar 10, envío mié 11)
1. (Antón) cliente de app y claves; yo: primera prueba real con el canal de Bluesky (solo borradores), grabar fixtures reales, corregir lo que la API real diga distinto.
2. Ruta `/api/buffer/replan`: POST calcula propuestas (lee la cola con `posts` + previsión nueva con `weekForecast` de `src/lib/sources/weather.ts`), POST con aprobados llama a `applyMoves`.
3. Interfaz (aún no hay): Conectar, Tablero de la semana (usa `GET /api/buffer/schedule?plan=...`), Revisar, Programar (borrador por defecto, interruptor), Cola y Re-planificar, siguiendo `DISENO_BRIEF.md` y comprobando en 390 px. Texto en inglés, primera persona, sin guiones largos.
4. Un botón para llevar el plan de una ejecución en vivo al escritor (hoy solo planes grabados vía `src/lib/demo-plans.ts`; el escritor ya acepta uno en vivo).
5. Ideas de Buffer (`ideas:write`) para el resto del plan, solo si sobra tiempo.
6. Vídeo (≤ 2 min, contra la API real) y resumen de ~300 palabras, primera persona, sin lenguaje de IA.

---

# Actualización 29-oct-2026 (rama `ui-29oct`, sin push)

## Qué se ha construido (pasos 2, 3 y 4)
Todo vive en `/week` (`src/components/week/*`), con los seis pasos: Conectar, Semana, Revisar, Programar, Cola y Re-planificar. El estado (plan, ediciones, canales, lo programado) sobrevive al viaje de ida y vuelta a Buffer con sessionStorage; los tokens siguen solo en cookies HttpOnly.
- Conectar: pantalla de consentimiento con lo que se pide y por qué, canales con avatar, servicio y zona horaria, máximo 5, avisa de canales desconectados o bloqueados, botón de desconectar.
- Semana: 4 repeticiones grabadas (o el plan de una ejecución en vivo), columnas por día con tiempo, lluvia y eventos; cada post como tarjeta a su hora con la imagen, la etiqueta y el «why now» con cita y fuente; mover arrastrando (escritorio) o con el botón Mover (día y hora, también en móvil y con teclado). La hora exacta, el día de la semana del título y la imagen se recalculan al mover.
- Revisar: texto por red con contador y límite de caracteres, quitar y volver a traer, deshacer ediciones, elegir canales por post, avisos del escritor, contador de límite diario (lee `dailyPostingLimits`; los borradores no cuentan).
- Programar: borrador por defecto; «Programar de verdad» exige marcar una confirmación; resumen con llamadas estimadas, notas de zona horaria y un informe por post (creado, ya existe, omitido, fallido).
- Cola: lo que Buffer tiene (`posts`) agrupado por día en la zona del canal, con su etiqueta, filtros y estados vacío, de carga, de error y de límite de ritmo.
- Re-planificar: diferencia de previsión día a día y propuestas `editPost` que solo se aplican si pulsas aprobar; para repeticiones hay un botón «Simular un cambio de previsión» claramente marcado como simulado. Hoy solo se compara la previsión (los eventos no se vuelven a leer, y la pantalla lo dice).
- Paso 4: en la home, el botón «Plan these posts in Buffer» en el resultado (enlace a la repetición, o traspaso del plan en vivo al escritor vía `/api/buffer/write`). Probado con el formato del plan en vivo contra la ruta, no con una ejecución en vivo real (gasta Nebius).
- Etiqueta «Recorded replay» en la cabecera, el tablero, Revisar, Programar y Re-planificar. 429/Retry-After muestra cuenta atrás.

Rutas nuevas: `/api/buffer/write`, `images`, `queue`, `replan`; `schedule` ahora acepta posts editados y destinos por post (valida con zod, repasa fechas y límites de caracteres antes de tocar Buffer). `replan` recalcula siempre en el servidor y solo aplica una propuesta si coincide con la aprobada (post y hora nuevos). Arreglo en `replan.ts`: un día que la previsión nueva no cubre ya no se lee como «la lluvia se fue».

## Comprobaciones (29-oct)
- typecheck y eslint limpios; `vitest`: 284 pasan, 5 saltados (antes 266). Nuevos: `tests/buffer/week.test.ts` (8) y `tests/buffer/routes.test.ts` (10: write, schedule con ediciones, 422 por texto largo o hora pasada, 429, queue, replan con aprobación, aprobación caducada).
- `npm run build` correcto (rutas `/week` y las 5 API nuevas).
- Navegador (Playwright, Chromium) contra el mock local (`npx tsx scripts/dev-mock-buffer.ts`, puerto de control 4011): flujo completo en 390×844 y 1440×900, sin scroll horizontal en ninguna pantalla; un único error de consola, el 429 provocado a propósito.
- Capturas: `docs/screenshots/ui-29oct/` (32 PNG: `390-*` y `1440-*`; picker, consentimiento, canales, tablero, mover, revisar, texto largo, programar, hecho, cola, re-plan con propuestas, aplicado, previsión en vivo, cola con 429 y cola vacía).

## Lo que no se ha podido hacer / límites honestos
- Nada probado contra el Buffer real (sigue sin cliente de app). El mock es el mismo de los tests.
- Eventos no se vuelven a consultar en Re-planificar; Ideas de Buffer sin hacer.
- Arrastrar es HTML5 (no funciona en pantalla táctil; ahí se usa Mover).
- Los avatares reales de Buffer pueden bloquearse por referrer; hay iniciales de respaldo.

## Para la versión enviable del lun 2-nov
1. Primer run real con el canal de Bluesky (solo borradores), grabar fixtures reales y corregir lo que la API diga distinto (p. ej. si `editPost` mantiene el borrador).
2. Probar `/week` con un plan en vivo real desde la home (un run de Nebius).
3. Ver en pantalla real el `Retry-After` y el tamaño de la cookie de sesión con el token real.
4. Vídeo y resumen (pasos 6 del plan).

## Lo que tiene que hacer Antón
Lo de la sección anterior sigue en pie: crear el app client, pegar las claves con `pegar-clave.ps1` y arrancar con `npx next dev --experimental-https`. El único gesto nuevo es el «Allow»: abre `https://localhost:3000/week`, ve a Conectar, pulsa «Connect your Buffer account» y en la pantalla de auth.buffer.com pulsa Allow una vez. Vuelves a `/week` ya conectado, eliges el canal de pruebas de Bluesky y todo se crea como borrador.

---

# Actualización 31-oct-2026 (agente de entrega)

## Bases leídas (buffer.com/api/commit y /terms, 31-oct) y cumplimiento
- Vídeo de 2 min o menos que muestre el proyecto funcionando de punta a punta contra la API de Buffer real (las diapositivas no valen): PENDIENTE de la toma en vivo (ver abajo).
- Enlace público vivo durante el jurado (16-20 nov): CUMPLE (https://tablecast-week.vercel.app/week, comprobado el 31-oct en 1440 y 390 px, sin desbordes ni errores de consola).
- Resumen de unas 300 palabras (problema, público, API usada, próximos pasos): CUMPLE, `competiciones/buffer/ENTREGA.md` (ig-human 79,7).
- Nombre legal, email y redes (los del registro): lo pone Antón. Client ID (no el secreto): lo pone Antón.
- OAuth de Buffer y al menos una llamada real: CUMPLE (conectado el 30-oct por Antón; canal de Bluesky de prueba).
- Proyecto existente: hay que indicar lo nuevo de la ventana: `BUFFER_CHANGES.md` (hay que añadir lo de la 29-oct, ver más abajo) y el resumen lo dice.
- Plazo: 13-nov 23:59 PT (sáb 14-nov 08:59 Madrid). Envío definitivo, no editable según el manual de PLAN.md.
- Posts de «build in public» (opcional, hasta 5, deben decir que promocionan el concurso): no hechos.

## Qué no he podido hacer y por qué
La sesión OAuth vive solo en el Chrome de Antón (cookies HttpOnly). Yo no tengo token, no uso Chrome y no puedo aceptar la pantalla de consentimiento. Por eso no hay fixtures reales ni toma contra el Buffer real todavía. No he llamado a la API de creación.
Garantía de borrador: la documentación (examples/create-draft-post) dice que con `saveToDraft: true` el post queda en `draft` y «no se publicará hasta que se programe explícitamente»; el código lo manda siempre por defecto y el script de captura aborta si el modo no es borrador. NO verificado: si `editPost` con `mode: customScheduled` mantiene el estado de borrador. Por eso la toma en vivo NO pulsa «Approve» (se enseña la propuesta); solo se aplica con `MOVE_LIVE=1`, y antes habría que probarlo con un post suelto y borrarlo si pasa a `scheduled`.

## Vídeo (herramientas en competiciones/_video-tools/video)
- Narración Kokoro lista: `C:\Users\anton\data\buffer\video\guion.txt` y `tts\` (82 s).
- `buffer-flow.mjs login`: abre Chromium (no Chrome) en la web publicada; Antón pulsa Connect y Allow una vez y se guarda `C:\Users\anton\data\buffer\pw-state.json` (contiene tokens, no subir).
- `buffer-flow.mjs run`: toma continua del recorrido completo (canal Bluesky, 6 borradores reales, cola, re-plan), guarda las respuestas de `/api/buffer/*` como fixtures en `video\take\fixtures.json`. Luego `node buffer-assemble.mjs C:\Users\anton\data\buffer\video\tablecast-week-demo.mp4` (voz, subtítulos quemados, -16 LUFS).
- Ensayo completo contra el mock local (no es para enviar): `C:\Users\anton\data\buffer\video\rehearsal-MOCK.mp4`, 85 s.

## Lo que queda
1. Antón: `cd C:\Users\anton\OneDrive\anton\competiciones\_video-tools\video; node buffer-flow.mjs login` (un Allow), y avisar. Después: `node buffer-flow.mjs run` y `node buffer-assemble.mjs ...`; revisar fotogramas.
2. Antón: subir el vídeo a YouTube, rellenar nombre legal, email, redes y client ID, y enviar el formulario (el envío no se puede editar).
3. Opcional: posts build in public (con aviso de que promocionan el concurso).
