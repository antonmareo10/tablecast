# What is new in the Buffer Commit window

Tablecast existed before the Buffer Commit window. The code that Nebius judged is tagged `nebius-submission` (origin/main at `876df62`, 28 Oct 2026 before the window opened at 07:01 UTC). Everything below is new work on the `buffer-commit` branch, made after that moment. Run `git log nebius-submission..buffer-commit` to see every commit.

| Date (UTC) | Commit | What |
|---|---|---|
| 2026-10-28 | `85a38f0` | Branch `buffer`, separate worktree, change log and third-party credits. |
| 2026-10-28 | `af37b14` | Buffer OAuth 2.0 with PKCE S256, sealed state cookie, single-owner rotating refresh (`src/lib/buffer/oauth.ts`, `seal.ts`, `config.ts`); typed GraphQL client with rate-limit handling and cache (`client.ts`); local mock of auth.buffer.com and api.buffer.com for tests. |
| 2026-10-28 | `6d9d096` | Writer: a recorded or live plan becomes posts with exact local times, why-now cites, per-network text and a date guard for post times, no model call (`src/lib/post-writer.ts`). |
| 2026-10-28 | `f7c104a` | `/api/post-image` (server-drawn PNG, HMAC-signed URL), scheduling into Buffer as drafts with tags, duplicate guard and daily-limit check (`src/lib/schedule.ts`), `/api/buffer/{login,callback,session,schedule}`, CI workflow. |
| 2026-10-28 | `a4de8af` | "The queue follows the weather": forecast and event diff, `editPost` move proposals applied only on approval (`src/lib/replan.ts`). |
| 2026-10-28 | `74c88b3` | `docs/BUFFER_API_NOTES.md`, `docs/ESTADO_BUFFER.md`, `.env.example` keys. |
| 2026-10-29 | `e57616e` | Routes for the screens: `/api/buffer/{write,images,queue,replan}`; scheduling takes edited posts and per-post channels; re-plan ignores days the new forecast does not cover. |
| 2026-10-29 | `dd51140` | The Tablecast Week screens: Connect, Week board, Review, Schedule, Queue and Re-plan, plus the hand-off from the home page. |
| 2026-10-29 | `62a4888` | Dev mock of Buffer for trying the screens, mobile header and step bar fixes, screenshots. |
| 2026-10-29 | `e376630` | Vercel project config for tablecast-week.vercel.app. |
| 2026-10-31 | `fcc583c` | Submission requirements map and video pipeline notes. |

Tested live on 4 Nov 2026 against the real Buffer API with one Bluesky test channel: OAuth, channels, daily limits, four posts created as drafts, the queue read back and a re-plan proposal (not applied). The demo video is that run.
