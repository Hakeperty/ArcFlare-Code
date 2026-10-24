# Security log and release gate: phone hub, relay tunnel, Android app

This file is the record of what was attacked, what was found, what was fixed,
and what is still open. It is updated as work happens, not at the end.

## What "safe" means here

Nothing can be proven 100% safe, and this file will never say it is. What it can
say is: **these attacks were tried, these were found, these were fixed and
re-tested, and these risks remain.** A clean red-team run means those attacks
failed, not that no attack exists. Release notes must repeat the "Not covered"
and "Residual risk" sections below, unedited.

## Release gate

Nothing ships (and the relay and Android app stay OFF by default) until every box
is ticked. A box is ticked only with a link to the passing test or report.

- [ ] Round 1: login, sessions, web server, agent/folder controls attacked, with exploit scripts actually run (not only a code read)
- [ ] Every critical and high finding fixed, each with a regression test
- [ ] Round 1 attacks re-run after the fixes and now fail
- [ ] Round 2: encrypted tunnel and relay (opus reviewer): replay, reorder, downgrade, wrong key, stolen QR, stolen phone, malicious relay
- [ ] Round 2 findings fixed and re-tested
- [ ] Round 3: Android app: credential storage, what the WebView may load, update signing, deep links, backup/screenshot exposure
- [ ] Round 3 findings fixed and re-tested
- [ ] Full test suite green on a clean checkout (`npm test`)
- [ ] Dependency check: still zero npm dependencies in the hub and tunnel; Android build dependencies listed and pinned
- [ ] Update path: version file and APK signed; app verifies the signature before installing anything it downloaded
- [ ] Relay is off by default and turning it on is an explicit command
- [ ] A human has read this file and the diff

## Findings

Severity: critical / high / medium / low. Status: open / fixed / accepted.

| # | Round | Sev | Finding | How found | Status | Fix and test |
|---|-------|-----|---------|-----------|--------|--------------|
| 1 | 1 | low-med | A username such as `__proto__` fit the username pattern. It re-parented the in-memory user table and the account vanished on the next save. No global pollution (verified). | Static review by an attacker agent, then confirmed by hand | fixed | `createAccount` refuses names on `Object.prototype`. Test: "names that exist on Object.prototype cannot be accounts" in `test/hub-auth.test.js` (commit c534278) |
| 2 | 1 | medium | A flood of logins with made-up usernames queued unbounded password-hash work (40 parallel took 1.1 s, starving the thread pool). | Static review, then confirmed by hand | fixed | At most 3 checks in flight, 12 queued, the rest answered `BUSY`, mapped to HTTP 503 with `Retry-After`. Test: "a flood of logins is bounded" (commit c534278) |
| 3 | 1 | low | A revoked session's live event stream can keep receiving for up to 15 s (until the next heartbeat re-check). | Static review | fixed | See row 16 |
| 4 | 1 | medium | Locking out by IP can be dodged by rotating real source addresses (for example an IPv6 /64). The per-username lockout still applies. | Static review | accepted for now | Documented limit. Revisit with the tunnel, which keys on paired device id |
| 5 | 1 | info | The first login after startup may take longer because the dummy hash is built lazily, a small timing difference. | Static review | open | Plan: build the dummy hash at construction |
| 6 | 1 | medium | The approval card showed only the first 2000 characters of a command, so a prompt-injected model could pad it and hide the harmful part past the cut-off while the person tapped Approve. | Review of supervisor by an attacker agent (reproduced with a fake agent) | fixed | Approvals are shown whole; over 8000 characters is denied without asking, with reason "too long to review safely". Test: "an approval is never shown truncated" |
| 7 | 1 | low-med | The model-swap guard ignored idle agents and concurrent starts, so a swap could leave an agent talking to a different model. | Same review (reproduced against a stubbed model loader) | fixed, untested | `lib/hub/cli.js` `makeBackend` now counts every live agent holding the loaded model, and booting agents. No automated test: `makeBackend` needs a test with a stubbed `serve`. **Open task** |
| 8 | 1 | low-med | A failed model load left a stale "loaded" cache pointing at a dead server. | Same review | fixed, untested | Cache cleared before each load. Same open test task as row 7 |
| 9 | 1 | low | `resolveModel` could climb a tier (a cheap request got the strongest model), and the "never up" comment was false. `arcflare phone tier set` accepted names that match nothing. | Same review | fixed | With tiers configured and nothing at or below the wanted tier it now returns no model; `tier set` validates the model. Test: "router.resolveModel falls back down, never up" updated |
| 10 | 1 | low | The "hard" tier is only a default-picker: any logged-in user can request `tier:"hard"` explicitly. | Same review | accepted | By design while there is one owner. Revisit if roles are added. Router comment and one hard-signal weight corrected (6 to 5) |
| 11 | 1 | low | No cap on number of agents (500 creates cost 0.5 s and rewrote the file each time); user events could carry 64 KB each. | Same review | fixed | At most 50 agents (`LIMIT`, HTTP 409); event text cut at 20 KB. Test: "the number of agents is capped". The event ring is still bounded by count, not bytes: **open** |
| 12 | 1 | low | A hand-edited `agents.json` could set an id or session id like `../../x` that reaches file paths. Needs write access to `~/.arcflare/hub`, not reachable over the API. | Same review | fixed | Ids are validated when loaded. Test: "a hand-edited agents.json cannot point ids at other folders" |
| 13 | 1 | low | `stop()` on an agent that ignores abort lets a restart run a second agent on the same session while the old turn finishes. Only matters if the real `Agent.abort()` is slow. | Same review (fake agent that ignores abort) | open | Plan: check `stopping` before saving the session, and refuse to boot while an old runtime for that id is unfinished |
| 14 | 1 | info | Any logged-in account can see and approve any agent (no per-user ownership). | Same review | accepted | By design for a single-owner hub. Required before multi-user |
| 15 | 1 | high | Pre-auth slow-body denial of service: a client could promise a body on `POST /api/login` and never send it. Node's request timeout covers headers only, so 500 such sockets stayed open past 35 s. | Web-server attacker agent (reproduced with 500 raw sockets) | fixed | The body reader has its own inactivity deadline (8 s) and answers 408 then closes. Test: "a body that never arrives is cut off, with no login needed" (the test hangs without the fix) |
| 16 | 1 | low | A revoked session's live stream kept delivering for up to the heartbeat (15 s). Same as row 3. | Web-server attacker agent (measured 15 s) | fixed | Logout, revoke-one and revoke-others close matching streams immediately; heartbeat shortened to 10 s for revokes made from the command line. Test: "revoking a device closes its live stream immediately" |
| 17 | 1 | low | No limit on open event streams per session (2000 held, +124 MB). | Web-server attacker agent | fixed | 8 streams per session, 64 overall, then 429. Test: "one session cannot hold more than a handful of streams open" |

## Round 1 status (honest)

- Two of the three attacker agents were stopped by a safety check before running any exploit. The login agent returned a static read only. The agent-escape agent returned nothing. The agent-escape work was re-issued as a narrower review (fake agent and backend only, no real tools).
- The agent-escape review was re-run as a narrower code review with a fake agent and backend, and reported (rows 6 to 14).
- The web-server attack agent reported and ran its scripts against a real in-process server (rows 15 to 17). Held up: spoofed forwarding headers and odd IPv6 forms, Host-header and DNS-rebinding tricks, cross-site requests of every simple form, file-leak and traversal variants, header splitting, request smuggling, oversized headers, clickjacking, response caching, and script injection in the phone UI (checked live in a real headless browser).
- Round 1 is **not yet closed**: the fixes still need the whole round re-run, and the login attacker agent never ran its dynamic attacks (only the two suspicions I checked by hand). Its two unconfirmed suspicions were checked by hand (rows 1 and 2); the rest of its areas still need dynamic testing.

## Round 2 status (tunnel and relay), in progress

- Tunnel protocol, hub side and phone-side module written by one agent; an independent opus review of it has been started and **has not reported**. Nothing here counts until it does.
- Website relay routes written and checked by script: 288 checks across the in-memory and Redis stores (memory re-run after the last change: 141 of 141), CORS limited to the exact app origins, blind to frame contents, nothing secret in responses or server output.
- Relay open items (not yet verified):
  - Not tested on a real Upstash or Vercel KV store (only real Redis 7 behind a local REST shim). Lua scripting limits there are unknown.
  - Frame-age (5 min), channel-idle (15 min) and room-expiry (30 days) paths are implemented but their timeouts were never waited out.
  - The failed-login lockout keys on the last `X-Forwarded-For` entry, which is right behind Vercel but would lump users together behind several appending proxies.
  - The `wait` clamp (25 s) was not exercised at its upper bound.
  - CORS was tested with hand-set headers, not in a real browser or the real app.
  - Anyone can create a room for their own token (spec); the only brake is per-IP and per-token limits.

## Controls in place (what the attacks run against)

- Accounts are created at the keyboard only. There is no sign-up endpoint.
- Passwords: scrypt (N=32768, r=8, p=1), per-user salt, constant-time compare, identical answer for unknown user and wrong password.
- Sessions: random 32-byte token, only its SHA-256 stored, idle expiry 7 days, absolute 30 days, per-device revoke, all revoked on password change.
- Cookies: HttpOnly, SameSite=Strict. CSRF token required on every state-changing request, plus an Origin check.
- Network: answers only private addresses unless `--allow-remote`. `X-Forwarded-For` is never trusted. Host-header allowlist against DNS rebinding.
- Responses: strict CSP (no inline script or style), no CORS headers, `no-store` on the API, `X-Frame-Options: DENY`.
- Agents: work only inside folders listed with `arcflare phone root add`. Every tool call asks the phone first. No answer within 5 minutes is a "no". Auto-approve cannot be switched on from the phone.
- Model tiers: the strongest tier only on an explicit request or strong signals.
- Zero npm dependencies in the hub.

## Not covered (so far)

- The encrypted tunnel, the relay routes on the website, and the Android app do not exist yet or have not been attacked.
- Plain HTTP on the home network exposes the password and session to anyone who can see the traffic, unless `--cert` and `--key` are used. Open until HTTPS is the default or the risk is accepted in writing.
- A person with a logged-in phone can approve tool calls, and tool calls run with your user's privileges. The approval prompt and the folder limits are the only barriers. This is a sandbox-less design by intent (see `SECURITY.md`).
- Malware already on the computer or the phone.
- Load and denial-of-service testing beyond the login flood above.

## Residual risk (to be copied into release notes)

1. Anyone who steals an unlocked, logged-in phone can use your agents until you revoke that device from the computer.
2. A prompt-injected agent can ask for approval of a harmful command. The person approving is the last line of defence.
3. Home Wi-Fi without HTTPS is readable by other devices on it.
4. The relay operator can see that a tunnel exists and when it is used (not what is in it, once the tunnel is built and verified).

## How to add a finding

Add a row, keep the number, never delete a row. When fixing, link the commit and
the test that fails without the fix. When a finding is accepted rather than
fixed, write who accepted it and why.
