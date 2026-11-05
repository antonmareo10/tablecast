// The judges' link, on the Otari side and on Vercel. Every Otari call here is free (reads, and the end-user routes that
// put an end user on a budget, block it or unblock it); nothing here runs a model, adds funds or adds provider keys.
// Secrets are never printed: the link goes to the clipboard and the screen only shows its first and last characters.
//
//   node --env-file=.env.local scripts/judge-link.mjs status            # budgets on the app's key + the judges' end user
//   node --env-file=.env.local scripts/judge-link.mjs setup --budget <budget_id>
//                                                                       # put the judges' end user on that budget
//   node --env-file=.env.local scripts/judge-link.mjs revoke            # block the judges' end user (instant, no deploy)
//   node --env-file=.env.local scripts/judge-link.mjs restore           # unblock it
//   node --env-file=.env.local scripts/judge-link.mjs token [--rotate] [--no-vercel] [--no-clipboard]
//                                                                       # new JUDGE_LINK_TOKEN: into .env.local and Vercel
//                                                                       # (production), the judges' link to the clipboard
//   node --env-file=.env.local scripts/judge-link.mjs env --budget <budget_id> [--expires <ISO date>] [--cap <USD>]
//                                                                       # JUDGE_BUDGET_ID, JUDGE_LINK_EXPIRES (default
//                                                                       # 2026-12-31T23:59:59Z), JUDGE_SPEND_CAP_USD on Vercel
//   node --env-file=.env.local scripts/judge-link.mjs url               # the judges' link to the clipboard again
//   node --env-file=.env.local scripts/judge-link.mjs owner             # the owner's live link (?live=) to the clipboard
//
// The end-user routes take only the app's service key (OTARI_API_KEY), which may put its end users only on a budget in
// its own end_user_budget_ids list (docs/end-users.md). Creating a budget, or adding one to that list, needs an
// organization owner: see JUDGE_LINK.md in the submission notes, or docs/OTARI_SETUP.md section 7.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const API = (process.env.OTARI_BASE_URL || "https://eu.api.otari.ai/api/v1").replace(/\/+$/, "").replace(/\/v1$/, "");
const KEY = process.env.OTARI_API_KEY;
const END_USER = process.env.JUDGE_END_USER || "judges:mozfest-wilding-2026";
const APP = (process.env.JUDGE_APP_URL || "https://tablecast-otari.vercel.app").replace(/\/+$/, "");
const ENV_FILE = process.env.JUDGE_ENV_FILE || ".env.local";
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "status";
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const masked = (s) => (s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-3)} (${s.length} characters)` : "(short)");

async function api(method, path, body) {
  if (!KEY) throw new Error("OTARI_API_KEY is not set: run with node --env-file=.env.local");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "user-agent": "tablecast-judge-link/0.8", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → ${res.status} ${res.headers.get("otari-error-code") ?? ""} ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const q = `?external_id=${encodeURIComponent(END_USER)}`;

async function budgets() {
  const list = await api("GET", "/v1/end-user-budgets");
  return (Array.isArray(list) ? list : (list.data ?? [])).map((b) => ({
    budget_id: b.budget_id ?? b.id,
    name: b.name ?? null,
    max_budget: b.max_budget ?? null,
    period: b.reset_alignment ?? (b.budget_duration_sec ? `${b.budget_duration_sec} s` : "never resets"),
    request_limit: b.request_limit ?? null,
    rpm_limit: b.rpm_limit ?? null,
    is_default: !!b.is_default,
    end_users: b.end_user_count ?? null,
  }));
}

async function judge() {
  const list = await api("GET", `/v1/end-users${q}`);
  const row = (Array.isArray(list) ? list : (list.data ?? []))[0];
  if (!row) return null;
  const { external_id, budget_id, blocked, spend, reserved, current_requests, budget_started_at, next_budget_reset_at, created_at } = row;
  return { external_id, budget_id, blocked, spend, reserved, current_requests, budget_started_at, next_budget_reset_at, created_at };
}

function copy(text) {
  const tool = process.platform === "win32" ? ["clip", []] : process.platform === "darwin" ? ["pbcopy", []] : ["xclip", ["-selection", "clipboard"]];
  const r = spawnSync(tool[0], tool[1], { input: text });
  if (r.status !== 0) throw new Error(`could not copy to the clipboard with ${tool[0]}`);
}

function setEnvLine(name, value) {
  let text = "";
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    /* a new file */
  }
  const re = new RegExp(`^${name}=.*$`, "m");
  const line = `${name}=${value}`;
  text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(ENV_FILE, text);
}

function vercelEnv(name, value) {
  const vercel = process.platform === "win32" ? "vercel.cmd" : "vercel";
  // The value goes in on stdin (never on the command line, so it never shows in a process list); --force replaces an old one.
  execFileSync(vercel, ["env", "add", name, "production", "--force", "--yes"], { input: value, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
}

const judgeUrl = (token) => `${APP}/?judge=${encodeURIComponent(token)}`;

async function main() {
  switch (cmd) {
    case "status": {
      console.log("Budgets the app's key may put end users on:");
      for (const b of await budgets()) console.log(" ", JSON.stringify(b));
      const j = await judge();
      console.log(`Judges' end user ${END_USER}:`, j ? JSON.stringify(j) : "not created yet (run setup)");
      console.log("JUDGE_LINK_TOKEN in", ENV_FILE + ":", process.env.JUDGE_LINK_TOKEN ? masked(process.env.JUDGE_LINK_TOKEN) : "not set (run token)");
      break;
    }
    case "setup": {
      const id = opt("--budget");
      const list = await budgets();
      if (!id) throw new Error(`name the budget: --budget <budget_id>. On this key: ${list.map((b) => `${b.budget_id} (${b.name ?? "no name"}, $${b.max_budget}, ${b.period})`).join("; ")}`);
      const b = list.find((x) => x.budget_id === id);
      if (!b) throw new Error(`${id} is not on the key's end_user_budget_ids, so Otari would refuse it (end_user_budget_not_allowed). Add it first (JUDGE_LINK.md).`);
      if (b.max_budget == null) throw new Error(`${id} has no dollar limit: it would not cap the judges.`);
      const row = await api("PUT", `/v1/end-users${q}`, { budget_id: id });
      console.log(`${END_USER} is on ${id} ($${b.max_budget}, ${b.period}):`, JSON.stringify({ budget_id: row.budget_id, blocked: row.blocked, spend: row.spend }));
      console.log(`Set JUDGE_BUDGET_ID=${id} on Vercel so the app refuses judge runs if the end user is ever on another budget.`);
      break;
    }
    case "revoke":
    case "restore": {
      const row = await api("PATCH", `/v1/end-users${q}`, { blocked: cmd === "revoke" });
      console.log(`${END_USER}: blocked = ${row.blocked}, spend = ${row.spend}`);
      break;
    }
    case "token": {
      if (process.env.JUDGE_LINK_TOKEN && !args.includes("--rotate")) throw new Error(`JUDGE_LINK_TOKEN is already set (${masked(process.env.JUDGE_LINK_TOKEN)}). Use url to copy the link, or token --rotate for a new one.`);
      const token = randomBytes(24).toString("base64url"); // 32 characters, 192 bits
      setEnvLine("JUDGE_LINK_TOKEN", token);
      console.log(`New JUDGE_LINK_TOKEN ${masked(token)} saved in ${ENV_FILE}.`);
      if (!args.includes("--no-vercel")) {
        vercelEnv("JUDGE_LINK_TOKEN", token);
        console.log("Saved on Vercel (production). It takes effect with the next deploy.");
      }
      if (!args.includes("--no-clipboard")) copy(judgeUrl(token));
      console.log(`The judges' link${args.includes("--no-clipboard") ? "" : " is on the clipboard"}: ${APP}/?judge=${masked(token)}`);
      break;
    }
    case "env": {
      // The judge link's other settings on Vercel (production). Not secrets, so they are printed.
      const budget = opt("--budget");
      if (!budget) throw new Error("name the judges' budget: env --budget <budget_id> [--expires <ISO date>] [--cap <USD>]");
      const expires = opt("--expires") ?? "2026-12-31T23:59:59Z";
      if (!Number.isFinite(Date.parse(expires))) throw new Error(`--expires ${expires} is not a date`);
      const settings = { JUDGE_BUDGET_ID: budget, JUDGE_LINK_EXPIRES: expires, ...(opt("--cap") ? { JUDGE_SPEND_CAP_USD: String(Number(opt("--cap"))) } : {}) };
      for (const [k, v] of Object.entries(settings)) {
        vercelEnv(k, v);
        console.log(`${k}=${v} saved on Vercel (production).`);
      }
      console.log("They take effect with the next deploy.");
      break;
    }
    case "url": {
      const token = process.env.JUDGE_LINK_TOKEN;
      if (!token) throw new Error("JUDGE_LINK_TOKEN is not set: run token first.");
      copy(judgeUrl(token));
      console.log(`The judges' link is on the clipboard: ${APP}/?judge=${masked(token)}`);
      break;
    }
    case "owner": {
      const token = process.env.LIVE_RUNS_TOKEN;
      if (!token) throw new Error("LIVE_RUNS_TOKEN is not set in .env.local.");
      copy(`${APP}/?live=${encodeURIComponent(token)}`);
      console.log(`The owner's live link is on the clipboard: ${APP}/?live=${masked(token)}`);
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
