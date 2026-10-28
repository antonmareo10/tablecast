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
