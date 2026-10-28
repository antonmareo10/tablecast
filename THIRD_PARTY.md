# Third-party material in the Buffer work

- Buffer sample apps, `samples/app-client-starter-app` (MIT, Copyright (c) 2026 Buffer), https://github.com/bufferapp/buffer-sample-apps. I read it to confirm the exact OAuth flow (PKCE S256, `client_secret_post`, rotating refresh token, `assets` and `needsApproval` being non-null on `createPost`, the per-service required `metadata`). The code in `src/lib/buffer/` is written from scratch in TypeScript for Next.js; no file was copied. The list of required metadata per service (instagram, facebook, google) follows the sample and was checked against the public reference at https://developers.buffer.com/reference.md.
- Buffer API documentation, https://developers.buffer.com (schema names, rate-limit headers, hosting rules for media).
