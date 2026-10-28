# Buffer API notes (checked 28 Oct 2026)

Sources: https://developers.buffer.com (every page has a `.md` twin, e.g. `/reference.md`, `/types/CreatePostInput.md`, `/llms.txt`) and the MIT sample app https://github.com/bufferapp/buffer-sample-apps (`samples/app-client-starter-app`). Nothing here was run against the live API yet: the app client does not exist until the owner creates it. What the tests run against is a local mock (`tests/helpers/mock-buffer.ts`) shaped from these pages. The first live run will record real responses.

## OAuth
- Authorize `https://auth.buffer.com/auth`, token `https://auth.buffer.com/token`. Authorization code with PKCE S256 is required even with a client secret. The server advertises only `none` and `client_secret_post`, so the secret goes in the form body, never HTTP Basic.
- Access token about 1 h. Refresh token only with `offline_access`; single use and rotating; reusing a spent one revokes the whole grant. Code: `src/lib/buffer/oauth.ts` (`TokenManager` is the only thing that refreshes; concurrent calls in one process share one refresh; the replacement is stored before anything else).
- Not solved, only documented: two serverless instances refreshing the same cookie at once. Mitigation: the browser calls `/api/buffer/session` first and the UI sends one request at a time.
- Redirect URIs must match character for character and be HTTPS (localhost too). A preview deploy cannot read the production host's cookie, so sign-in is off on previews.
- Scopes used: `account:read posts:read posts:write offline_access` (`ideas:write` is not requested because Ideas are not used yet).

## GraphQL (one endpoint, `https://api.buffer.com`, POST, `Authorization: Bearer`)
Verified field names (reference.md):
- `account { id organizations { id name } }`; `channels(input: { organizationId })` returns `id name displayName service avatar timezone isDisconnected isLocked isQueuePaused` (timezone default is Europe/London when unset).
- `createPost(input: CreatePostInput!)`. Non-null in the schema: `channelId`, `mode`, `schedulingType`, `assets` (default `[]`), `needsApproval` (default false). `dueAt` is an ISO 8601 `DateTime`. `saveToDraft: true` makes a draft and skips posting limits. Result is a union: `PostActionSuccess { post }` or typed errors that implement `MutationError { message }`. Select `__typename` and `... on MutationError`.
- Per service required `metadata` (schema marks these fields non-null): Instagram `{ type: post, shouldShareToFeed: true }`, Facebook `{ type: post }`, Google Business `google: { type: whats_new }`. Others need none. The GBP input is flagged deprecated "pending proposal for specific post types".
- `editPost(input: EditPostInput!)`: same fields plus `id`; `mode` omitted or null means "no scheduling change". Plan said `editPost` can move a post: it takes `mode` + `dueAt`. **Unverified live**: whether a draft keeps draft status when edited with `mode: customScheduled`; the code sends `saveToDraft: true` for drafts to be safe.
- `deletePost(input: { id })` returns `DeletePostSuccess { id }` or `VoidMutationError`.
- `posts(input: { organizationId, filter: { status, channelIds, tagIds, ... }, sort: [{ field: dueAt, direction: asc }] }, first, after)` returns `edges { node }` and `pageInfo`. Status values: `draft error needs_approval scheduled sending sent`.
- `dailyPostingLimits(input: { channelIds, date })` returns `channelId isAtLimit limit scheduled sent` (`limit` null means unlimited). Drafts are not checked by the API, so the code checks only when scheduling for real.
- Tags: `createTag(input: { organizationId, tag: { name, color } })` (name unique, color `#RRGGBB`, needs `posts:write`, experimental, may return `LimitReachedError` by plan). Listing is `tagsV2(input: { organizationId }, first)`, also experimental. The code uses one tag per reason ("Tablecast · rain", "· sun", "· event", "· dish"), reused every week, to stay under plan limits.
- Error codes seen in the docs: `UNAUTHORIZED`, `RATE_LIMIT_EXCEEDED` in `errors[].extensions.code`. A 401 or `UNAUTHORIZED` means reconnect.

## Limits
- 100 requests / 15 min, 250 / day, 3,000 / 30 days per app client, shared by every user of the app (judges included). Headers on every response: `RateLimit: "100-in-15min";r=98; t=897, ...` (note the space after `;`) and `RateLimit-Policy`. `429` carries `Retry-After`.
- The client reads those headers, waits out a `Retry-After` of 5 s or less once, otherwise reports the wait, and refuses to call when a window is empty. Organizations and channels are cached 10 min in memory per account.
- Cost of "schedule one plan to one channel": 1 (tags list) + new tags + 1 (existing posts) + one per post, about 8 to 14 calls. Three judges doing it on three channels each stays well under 250 per day only if they do it a few times: this is the shared-quota risk.

## Media
No upload endpoint. The URL must be public, direct, HTTPS and stable until the post publishes (Buffer downloads it at publish time). `src/lib/post-image.ts` signs the image spec with HMAC-SHA256 and `/api/post-image` draws the PNG; the URL never expires while the deploy and `IMAGE_SIGNING_SECRET` (or `SESSION_SECRET`) live. Changing the secret breaks the URLs of posts already queued.

## Not available
Post metrics for third-party apps (only personal API keys). Do not promise analytics.

## What differs from PLAN.md
- `ideas:write` and Ideas are not used yet (scope left out).
- Tags are per reason, not per day ("rain Fri 23"), because of plan tag limits.
- Google Business Profile IS a supported service (`googlebusiness`), with `whats_new` metadata. The writer already has a Google variant.
- Metrics: not available, as the manual says.
