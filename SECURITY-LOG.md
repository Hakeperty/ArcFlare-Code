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
| 3 | 1 | low | A revoked session's live event stream can keep receiving for up to 15 s (until the next heartbeat re-check). | Static review | open | Plan: re-check on every event send and shorten the heartbeat; add a test that revocation closes the stream within one event |
| 4 | 1 | medium | Locking out by IP can be dodged by rotating real source addresses (for example an IPv6 /64). The per-username lockout still applies. | Static review | accepted for now | Documented limit. Revisit with the tunnel, which keys on paired device id |
| 5 | 1 | info | The first login after startup may take longer because the dummy hash is built lazily, a small timing difference. | Static review | open | Plan: build the dummy hash at construction |

## Round 1 status (honest)

- Two of the three attacker agents were stopped by a safety check before running any exploit. The login agent returned a static read only. The agent-escape agent returned nothing. The agent-escape work was re-issued as a narrower review (fake agent and backend only, no real tools).
- The web-server attack-surface agent had not reported when this was written.
- So round 1 is **incomplete**. Its two unconfirmed suspicions were checked by hand (rows 1 and 2); the rest of its areas still need dynamic testing.

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
