// A local stand-in for auth.buffer.com and api.buffer.com so the screens can be tried without a Buffer app client.
// It is the same mock the tests use (tests/helpers/mock-buffer.ts), seeded with a few channels, plus a tiny control
// port to provoke states: GET http://127.0.0.1:4011/ctl?limit429=3&retry=90 | ?reset=1 | ?state=json
//
//   npx tsx scripts/dev-mock-buffer.ts          (prints the env to start `next dev -p 3100` with)

import http from "node:http";
import { startMockBuffer } from "../tests/helpers/mock-buffer";

const APP = process.env.APP_ORIGIN ?? "http://localhost:3100";
const avatar = (bg: string, ch: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${bg}"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="#fff" font-family="sans-serif">${ch}</text></svg>`)}`;

async function main() {
const mock = await startMockBuffer({ clientId: "dev-client", redirectUri: `${APP}/api/buffer/callback` });
mock.state.channels = [
  { id: "ch-bsky", name: "tablecast-test.bsky.social", displayName: "Tablecast test", service: "bluesky", avatar: avatar("#2F6FB5", "T"), timezone: "America/Los_Angeles", isDisconnected: false, isLocked: false, isQueuePaused: false },
  { id: "ch-ig", name: "gjelina_test", displayName: null, service: "instagram", avatar: avatar("#AD4823", "G"), timezone: "Europe/Madrid", isDisconnected: false, isLocked: false, isQueuePaused: false },
  { id: "ch-fb", name: "Gjelina Venice", displayName: null, service: "facebook", avatar: avatar("#6B3B5A", "F"), timezone: "America/Los_Angeles", isDisconnected: true, isLocked: false, isQueuePaused: false },
];

http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.searchParams.get("reset")) {
    mock.state.fail429 = { times: 0, retryAfter: 1 };
    mock.state.posts.length = 0;
    mock.state.tags.length = 0;
    mock.state.limits = {};
    mock.state.mutationError = null;
  }
  const n = Number(u.searchParams.get("limit429"));
  if (n) mock.state.fail429 = { times: n, retryAfter: Number(u.searchParams.get("retry")) || 90 };
  const atLimit = u.searchParams.get("atLimit");
  if (atLimit) mock.state.limits[atLimit] = { isAtLimit: true, limit: 3, scheduled: 3, sent: 0 };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ posts: mock.state.posts.length, tags: mock.state.tags.length, fail429: mock.state.fail429 }));
}).listen(4011, "127.0.0.1");

console.log(JSON.stringify({
  authUrl: mock.authUrl, tokenUrl: mock.tokenUrl, apiUrl: mock.apiUrl,
  env: { BUFFER_CLIENT_ID: "dev-client", BUFFER_REDIRECT_URI: `${APP}/api/buffer/callback`, BUFFER_AUTH_URL: mock.authUrl, BUFFER_TOKEN_URL: mock.tokenUrl, BUFFER_API_URL: mock.apiUrl, PUBLIC_ORIGIN: APP },
}));
process.on("SIGTERM", () => void mock.close().then(() => process.exit(0)));
}

void main();
