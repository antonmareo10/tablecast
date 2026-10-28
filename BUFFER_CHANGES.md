# What is new in the Buffer Commit window

Tablecast existed before the Buffer Commit window. The code that Nebius judged is tagged `nebius-submission` (origin/main at `876df62`, 28 Oct 2026 before the window opened at 07:01 UTC). Everything below is new work on the `buffer` branch, made after that moment. Run `git log nebius-submission..buffer` to see every commit.

| Date (UTC) | Commit | What |
|---|---|---|
| 2026-10-28 | `85a38f0` | Branch `buffer`, separate worktree, change log and third-party credits. |
| 2026-10-28 | `af37b14` | Buffer OAuth 2.0 with PKCE S256, sealed state cookie, single-owner rotating refresh (`src/lib/buffer/oauth.ts`, `seal.ts`, `config.ts`); typed GraphQL client with rate-limit handling and cache (`client.ts`); local mock of auth.buffer.com and api.buffer.com for tests. |
| 2026-10-28 | `6d9d096` | Writer: a recorded or live plan becomes posts with exact local times, why-now cites, per-network text and a date guard for post times, no model call (`src/lib/post-writer.ts`). |
| 2026-10-28 | `f7c104a` | `/api/post-image` (server-drawn PNG, HMAC-signed URL), scheduling into Buffer as drafts with tags, duplicate guard and daily-limit check (`src/lib/schedule.ts`), `/api/buffer/{login,callback,session,schedule}`, CI workflow. |
| 2026-10-28 | `a4de8af` | "The queue follows the weather": forecast and event diff, `editPost` move proposals applied only on approval (`src/lib/replan.ts`). |
| 2026-10-28 | (next) | `docs/BUFFER_API_NOTES.md`, `docs/ESTADO_BUFFER.md`, `.env.example` keys. |

Not built yet: the screens (Connect, Week board, Review, Schedule, Queue, Re-plan) and the `/api/buffer/replan` route. See `docs/ESTADO_BUFFER.md`.
