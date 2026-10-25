# ArcFlare hub relay tunnel — protocol v1

Status: normative. Implementations: `lib/hub/tunnel.js` (hub, Node `crypto`),
`lib/hub/ui/tunnel-client.js` (phone, WebCrypto), `lib/hub/lanrelay.js` (the
hub's own mailbox, section 16). Tests: `test/hub-tunnel.test.js`,
`test/hub-tunnel-robust.test.js`, `test/lanrelay.test.js`, `test/hub-lan.test.js`,
`test/hub-lan-cli.test.js`.
MUST / SHOULD / MAY are as in RFC 2119.

## 1. Purpose and scope

When the phone cannot reach the hub's LAN address, it reaches the hub through the
arcflare.net relay mailbox. The relay (its operator, its Redis, anyone who owns
either) MUST NOT be able to read traffic, learn the password or session cookie,
inject or replay requests, or impersonate either end. It can only delay, drop or
refuse to carry frames (denial of service), and it sees metadata (section 13).

- The home network uses the SAME tunnel, carried by a mailbox the hub hosts
  itself on its LAN listener (section 16): no internet needed, pairing included,
  identity pinned by the hub key, nothing readable on the wire. The app never
  loads the hub's plain-HTTP page any more (no identity proof, no encryption);
  the hub's web UI remains for browsers on the computer or LAN.
- The relay is OFF by default. `arcflare phone relay on [url]` turns it on;
  the hub process (`arcflare phone`) then keeps one long-poll open to the relay.
- Login happens inside the tunnel with the same accounts as the LAN. The relay
  never sees a password, cookie or CSRF token.

## 2. Primitives and platforms

Only primitives present in both Node `crypto` and browser WebCrypto are used:

| Use | Primitive |
|---|---|
| Key agreement | X25519 (RFC 7748). An all-zero shared secret MUST be rejected. |
| Hash | SHA-256 |
| KDF | HMAC-SHA256 / HKDF-SHA256 (RFC 5869) |
| AEAD | AES-256-GCM, 96-bit nonce, 128-bit tag |

No signatures are needed (Ed25519/ECDSA unused): authentication is by static
Diffie-Hellman, as in Noise.

- Phone: WebCrypto X25519, i.e. **Chrome / Android System WebView 133 or newer**,
  in a **secure context** (the Capacitor app's `https://localhost` origin
  qualifies; the hub's own `http://192.168.x.x` page does not). The app MUST
  feature-detect (`generateKey({name:"X25519"})`) and refuse to pair if absent,
  never fall back to a weaker scheme.
- Hub: Node >= 18 (`crypto.diffieHellman`, `aes-256-gcm`, HMAC). No dependencies.

## 3. Notation and encodings

- `||` concatenation; `b64u(x)` base64url without padding. Receivers MUST accept
  only canonical base64url (re-encoding the decoded bytes gives the same text).
- `KDF(secret, label) = HMAC-SHA256(secret, UTF8(label) || 0x01)`
  (= HKDF-Expand(PRK=secret, info=label, L=32); secrets are 32 uniform bytes).
- `H(token) = b64u(SHA-256(UTF8(token)))` — the only form in which the relay
  stores a token.
- Noise: the Noise Protocol Framework rev. 34 with `HASH=SHA-256`, `DH=25519`,
  `CIPHER=AESGCM` (nonce = 4 zero bytes || 64-bit big-endian counter),
  `HKDF(ck, ikm, n)` = RFC 5869 with `salt=ck`, `info=""` (identical to Noise's).
  Handshakes are standard Noise; transport framing (section 7) is ArcFlare's.

## 4. Long-term state

On the hub, under `<ARCFLARE_HOME>/hub/`, every file mode 0600, written by
temp-file + rename, re-read by the running hub when it changes on disk:

| File | Contents | Secret? |
|---|---|---|
| `tunnel-key.json` | hub static X25519 private key `HS`, room secret `R` (32 B) | yes |
| `devices.json` | per device: id, label, X25519 public key, `H(roomToken)`, paired/approved times, pending SAS | no (public keys and hashes only) |
| `pairing.json` | per pending pairing: `pid`, `psk`, `H(pairToken)`, expiry, failures | `psk`, for ≤ 10 min; erased on use |

Derived:

- `hubToken = "afth_" || b64u(KDF(R, "arcflare-tunnel hub-token"))`
- `roomId = H(hubToken)` (43 chars). `roomRaw` = its 32 raw bytes.

On the phone (app storage; IndexedDB, never `localStorage`): `relay`, `roomId`,
pinned hub public key `HS_pub`, `deviceId`, `roomToken`, and the device static
X25519 key `DS`, generated **non-extractable**.

Deleting `tunnel-key.json` rotates everything and unpairs every phone.

## 5. Pairing

### 5.1 The link (QR)

`arcflare phone pair` creates a pending pairing with a fresh 32-byte secret `P`
and prints a QR of:

```
arcflare://pair?v=1&r=<urlenc relay>&rm=<roomId>&hk=<b64u HS_pub>&ps=<b64u P>[&l=<urlenc LAN base URL>]
```

`l` is the hub's LAN mailbox base URL (`http://<lan-ip>:<port>`, section 16): a
base for the Relay API, **not a page to open**. When the internet relay is off,
`r` is that same LAN base URL, so the phone's pairing record is always complete
(`r`, `rm`, `hk`); `rm` is always present.

- A custom scheme, deliberately not an `https://arcflare.net/...` URL: no web
  page — in particular none served by the relay — ever loads with `P` in it.
- `hk` is the hub's full public key: the phone **pins** it. There is no
  trust-on-first-use; a relay answering with any other key fails the handshake.
  The CLI also prints a short fingerprint (`SHA-256(HS_pub)` first 10 bytes, hex)
  that the app MAY show.
- `v` MUST be `1`; the app MUST reject other values and non-`https` relays,
  with two exceptions for plain `http`: loopback (development), and the **LAN
  exception** — `r` and `l` MAY be `http://` (or `https://`) when the host is a
  private IPv4 literal (10/8, 172.16/12, 192.168/16) or a `*.local` name
  (section 16). Any other `http` URL, and any `l` that fails the same rule, is
  rejected. The hub's own `relay` setting (the internet relay) stays https-only;
  the LAN exception exists only for the hub's own mailbox.
- `P` is one-time and expires after **10 minutes**. At most 4 pairings are
  pending; creating a fifth drops the oldest.

From `P`, both sides derive:

- `pid = KDF(P, "arcflare-tunnel pair-id")[0..16]` (in the clear in HS1)
- `psk = KDF(P, "arcflare-tunnel pair-psk")` (Noise PSK)
- `pairToken = "aftc_" || b64u(KDF(P, "arcflare-tunnel pair-token"))` (relay access)

The hub stores `pid`, `psk`, `H(pairToken)`, never `P`, and registers
`H(pairToken)` with the relay with `exp` = the pairing expiry.

### 5.2 Pairing handshake: `Noise_IKpsk1_25519_AESGCM_SHA256`

```
<- s                         (HS_pub, from the QR)
...
-> e, es, s, ss, psk         (HS1, mode PAIR)
<- e, ee, se                 (HS2)
```

Prologue (all handshakes): `"ArcFlare-Tunnel/1" || 0x00 || 0x01(version) || mode || roomRaw || idField(16) || sid(16)`,
with `mode` 1 = KK, 2 = PAIR; `idField` = `pid` (PAIR) or the raw device id (KK);
`sid` = 16 random bytes chosen by the phone. The prologue binds the cleartext
frame header, so any change to it fails the handshake.

HS1 payload (JSON, section 7.3): `{"t":"pair","ts":<ms epoch>,"label":"<≤60 chars>"}`.

The hub, on HS1 for a known, unused, unexpired `pid`:

1. runs the responder; any failure (bad AEAD, low-order key) counts against the
   pairing; after **5** failures the pairing is destroyed;
2. requires `|ts - now| ≤ 10 min` and an ephemeral key not seen in 20 min;
3. **consumes** the pairing before replying (one-time; a replay or a second
   phone loses). Its `psk` is erased; only `H(pairToken)` is kept, for a
   **2-minute grace** (never past the original expiry) so the phone can collect
   HS2 on the same relay channel;
4. creates device `id = b64u(16 random bytes)` with the phone's static key from
   the `s` token, `roomToken = "aftc_" || b64u(32 random bytes)`, state
   *pending*, and registers `H(roomToken)` with the relay;
5. replies HS2 with payload `{"t":"paired","ts","deviceId","roomToken","status":"pending"}`.

No transport session is opened by pairing.

### 5.3 Confirmation (SAS) — required

Both sides compute `SAS = uint32_be(SHA-256("ArcFlare-Tunnel SAS" || h)[0..4]) mod 10^6`
(6 digits) from the final handshake hash `h`. The phone shows it; the person at
the computer confirms it in `arcflare phone pair` (or
`arcflare phone devices approve <id>`, which shows the code and, with no terminal
to confirm on, refuses unless `--yes` is given). Only then is the device
*approved*. The label the phone chose is reduced to printable characters (no
control, format or bidi characters, at most 60) before it is stored or shown.
Pending devices that are not approved within **15 minutes** are deleted.
Approval is only possible at the keyboard, never over the network. Maximum
**16** devices.

## 6. Session handshake: `Noise_KK_25519_AESGCM_SHA256`

```
-> s                         (DS_pub, known to the hub from pairing)
<- s                         (HS_pub, pinned)
...
-> e, es, ss                 (HS1, mode KK)
<- e, ee, se                 (HS2)
```

- HS1 payload `{"t":"hello","ts":<ms>}`; the hub requires `|ts - now| ≤ 10 min`
  and a never-seen ephemeral key (20-minute cache). Only the holder of `DS`
  can produce a valid HS1 (`ss`); only the holder of `HS` can read it (`es`).
- HS2 payload `{"t":"welcome","ts","status":"ok"|"pending","rekeyFrames","maxAgeMs"}`.
  For a known but not yet approved device the hub answers `pending` and opens
  nothing; the phone retries later.
- Unknown device, revoked device, wrong key, stale timestamp, replayed
  ephemeral, rate limit exceeded: **silence** (no error oracle).
- `Split()` gives `k1` (phone→hub) and `k2` (hub→phone). Final keys depend on
  `ee`, so recorded traffic stays secret even if both static keys later leak
  (forward secrecy). Final keys also depend on `se`/`es`, so a stolen `HS` alone
  cannot impersonate a phone, and a stolen `DS` alone cannot impersonate the hub.
- The hub keeps ≤ 4 sessions per device and ≤ 64 in total (oldest closed first)
  and accepts ≤ 60 handshakes per minute. A handshaken connection is only
  counted, and only evicts the oldest, once its first authenticated DATA frame
  arrives; a replayed HS1 (the replay cache is in memory, so after a hub restart
  one inside its 10-minute window is answered) therefore opens nothing.

## 7. Frames and transport

### 7.1 Frame formats (binary; carried by the relay as base64url text)

| Type | Layout |
|---|---|
| HS1 | `ver=0x01` `type=0x01` `mode` `sid[16]` `idField[16]` `e[32]` `rest of Noise message 1` |
| HS2 | `ver=0x01` `type=0x02` `sid[16]` `e[32]` `rest of Noise message 2` |
| DATA | `ver=0x01` `type=0x03` `sid[16]` `n: u64 BE` then `AES-256-GCM(k_dir, nonce(n), ad = these 26 header bytes, plaintext)` |
| RESET | `ver=0x01` `type=0x04` `sid[16]` (hub → phone only; unauthenticated hint) |

Limits: decoded frame ≤ 32 896 bytes; text ≤ 44 000 characters; plaintext ≤ 24 KiB.
Unknown version or type: drop.

### 7.2 Counters, replay and order — strict

Each direction has its own key and its own counter `n`, starting at 0, used as
the nonce, incremented once per DATA frame. A sender MUST NOT reuse `n` with
the same key (it may re-send the *identical* frame after a network failure).
The receiver holds `expected`:

- `n < expected`: duplicate or replay → **drop silently**, session unaffected;
- `n > expected`: a frame is missing or reordered → **end the session**;
- `n == expected` but AEAD fails: tampering → **end the session**;
- otherwise process and set `expected = n + 1`.

Ending a session cancels its requests; the hub sends RESET so the phone
re-handshakes. Frames for an unknown `sid` get one RESET per 5 s per `sid`.
A DATA frame for a session MUST arrive on the relay channel that carried its
HS1, else it is dropped. `n` MUST stay below 2^48.

Safer-choice note: ending the session on a gap or AEAD failure trades
availability for a simple, fail-closed state machine. A relay can deny service
anyway; it cannot make either side accept a wrong frame.

### 7.3 Messages

Plaintext is a UTF-8 JSON object with a string `t`, followed by ASCII spaces up
to a multiple of 256 bytes (length padding; receivers accept trailing spaces).
Unknown `t` ends the session (on the phone too, even when the `id` is unknown).

Phone → hub:

| `t` | fields | meaning |
|---|---|---|
| `req` | `id` (integer, strictly increasing per session), `m` method, `p` path, `h` headers, `end` bool | start a request; `end:true` = no body |
| `body` | `id`, `d` (b64u, ≤ 12 KiB raw; the hub ends the session on a larger chunk) | next body chunk, in order |
| `end` | `id` | body complete; the hub dispatches now |
| `cancel` | `id` | abort (closes an SSE stream) |
| `ping` / `bye` / `rekey` | — | keepalive / close session / see 7.4 |

Hub → phone:

| `t` | fields | meaning |
|---|---|---|
| `res` | `id`, `s` status, `h` headers | response head (exactly once) |
| `data` | `id`, `d` (b64u, ≤ 12 KiB raw) | body chunk, in order; SSE text arrives as a stream of these |
| `end` | `id` | response complete |
| `err` | `id`, `e` | hub aborted the request |
| `pong` / `rekey` | — | |

Request rules (hub): methods GET HEAD POST PUT PATCH DELETE; path MUST match
`^/api(/|\?|$)`, printable ASCII, ≤ 2048 chars (anything else: 404 — static
files are not served through the tunnel, the app bundles its UI); headers
forwarded only from `content-type`, `accept`, `x-csrf-token`, `last-event-id`
(no CR/LF/NUL, ≤ 4 KiB each); everything else, including `cookie`, `host`,
`origin`, `x-forwarded-for`, is ignored. Body ≤ 128 KiB (the handler's own
64 KiB limit then applies); ≤ 16 requests in flight per session. A request the
hub refuses up front (404, 405, 429) is answered at once and its remaining
`body`/`end` messages are swallowed; they do not end the session. Response
headers forwarded: `content-type`, `retry-after`, `cache-control`.

SSE: `GET /api/events` or `/api/agents/<id>/events` with `accept: text/event-stream`;
the response stays open and its bytes stream as `data` messages (coalesced every
20 ms or 12 KiB). Resume after a reconnect with `last-event-id`. The hub ends a
stream whose unsent backlog exceeds 1 MiB (same rule as the LAN), and closes it
at the next heartbeat when the login session is revoked.

### 7.4 Rekey and lifetime

- In-band rekey: after 1024 frames or 10 minutes in a direction (the hub tells
  the phone its frame limit in HS2; each side may rekey earlier), the sender
  sends `{"t":"rekey"}` as the last frame under the old key, then sets
  `k = REKEY(k)` (Noise: first 32 bytes of `ENCRYPT(k, 2^64-1, "", 0^32)`); the
  receiver does the same after processing that frame. Counters continue. Old
  keys are discarded, so a later compromise of the current key does not expose
  earlier epochs.
- Full re-handshake (fresh `ee`): sessions end after **24 h**, or **30 min**
  idle with nothing in flight. The client module then fires `onclose`; the app
  calls `connect()` again (and re-opens SSE streams with `last-event-id`).

## 8. Bridging into the hub

The hub feeds each decrypted request into the **same** request handler as the
LAN socket, in-process (`server.dispatchTunnel(req, res, {deviceId})`):

- The private-address gate is skipped **only** for request objects registered
  by `dispatchTunnel` in a module-private `WeakMap`. Nothing a client sends
  (header, path, body) can set that mark. Real socket requests never get it.
- `Host: localhost` is set by the hub, so the Host allowlist runs and passes;
  `Origin` is never forwarded.
- Cookie session, CSRF (`x-csrf-token` on every mutation), JSON content type and
  body limits all apply unchanged.
- Login lockout keys on `relay:<deviceId>` instead of the socket address (all
  tunnel requests share one process), plus the existing per-username counter.
  A device cannot change its id without a new, keyboard-confirmed pairing.
  Sessions created through the tunnel show `ip = relay:<deviceId>`.
- **Session cookie stays on the hub.** `Set-Cookie` from the handler is removed
  from the tunneled response and kept in an in-memory per-device jar, which is
  replayed as `Cookie` on that device's later tunneled requests. The phone and
  the relay never hold the session token. Cost (safer choice): after a hub
  restart the phone signs in again over the relay. `/api/me` still returns the
  CSRF token to the page as on the LAN.

## 9. Relay access without trusting the relay

- The hub authenticates with `hubToken`; the relay files the room under
  `roomId = H(hubToken)`, so it can check the token but nobody can claim a room
  without the token (no preimages).
- Phones authenticate with a per-device `roomToken` (random, issued inside the
  encrypted HS2), or `pairToken` while pairing. The hub publishes the allowlist
  of `H(token)` (with expiry for pairing tokens); the relay stores only hashes.
- Deviation from the brief (safer): room tokens are *not* all derived from the
  pairing secret. `P` is one-time and short-lived, and a shared derived token
  could not be revoked per device. Only `pairToken` derives from `P`.
- The relay sees bearer tokens in transit. They open the mailbox only; every
  frame is still authenticated end to end, so a token thief gets denial of
  service at most.

## 10. Revocation and the stolen phone

`arcflare phone devices revoke <id>` (at the computer):

1. deletes the device from `devices.json` — the hub refuses its handshakes;
2. ends every login session with `ip = relay:<id>` in `auth.json`;
3. the running hub notices on the very next frame from that device (it checks
   the files' timestamps at every DATA frame; otherwise within ~2 s): closes the device's live sessions
   (RESET), signs out the jar session, drops the jar, and republishes the relay
   allowlist without `H(roomToken)` (relay access gone, 401).

Also available: revoke the login session from the Devices page (the phone must
sign in again, but stays paired); `arcflare phone user passwd` (ends every
session of that user); deleting `tunnel-key.json` (unpairs all phones).
A stolen phone with the app unlocked still needs the account password to sign
in once its jar session is gone.

## 11. Downgrade protection

There is exactly one suite per mode; nothing is negotiated. The version and mode
are in the prologue, so altering them breaks the handshake. Paired devices may
use only KK; PAIR is only accepted for a live, unused `pid`. A future v2 MUST
use a new version byte and protocol label and MUST NOT be offered to a device
the hub only knows as v1 (no silent fallback). The app refuses links with `v≠1`.

## 12. Abuse limits (hub side)

Handshakes ≤ 60/min; pairing failures ≤ 5 per pairing; ≤ 4 pending pairings;
≤ 16 devices; ≤ 4 sessions/device, ≤ 64 total; ≤ 16 requests in flight per
session; request body ≤ 128 KiB, body chunk ≤ 12 KiB; RESETs for unknown
sessions ≤ 10/s in total (all channels together); outbound backlog to the relay
≤ 8 MiB **and** ≤ 4096 frames, for every frame type (when full with DATA frames
all sessions are closed and the DATA dropped, once; any other frame that does
not fit is dropped, the new one, never a re-scan of the queue); a relay reply is
read as text, at most 3 MB, before it is parsed (larger: treated as a relay
failure), and at most 256 frames of a reply are processed (the phone applies the
same two caps); a handshake that has not yet sent an authenticated DATA frame is
not a session: it counts toward no cap and evicts nothing (≤ 128 such, 2 min);
relay poll backoff 1 s → 30 s. Relay-side limits are in the Relay API below.

## 13. Threats

| Threat | Result | Why |
|---|---|---|
| Malicious relay / stolen Redis reads traffic | nothing readable | AES-256-GCM under keys from X25519 the relay never has; only token hashes stored |
| Relay injects / modifies frames | rejected; session ends | AEAD over header + body; strict counters |
| Relay replays frames (same or other channel) | dropped, no side effect | counter below expected; channel binding; HS1 ephemeral cache + timestamp |
| Relay reorders / drops frames | session ends; phone reconnects | strict counters (DoS only) |
| Relay impersonates the hub (pair or KK) | handshake fails | `HS_pub` pinned from the QR; `es`/`ss` need `HS` |
| Relay impersonates a phone | handshake fails | needs `DS` (`ss`, `se`) or `psk` |
| Relay learns password / cookie / CSRF | no | login is inside the tunnel; cookie never leaves the hub |
| Relay serves a page that steals the pairing secret | not possible | link is `arcflare://`, never loaded by a web page |
| Network attacker between phone/hub and relay | same as malicious relay, plus HTTPS | |
| Stolen phone | cut off by `devices revoke` | hub, relay allowlist and login sessions (section 10) |
| Stolen pairing QR before use | attacker's pairing is not approved | one-time, 10 min, SAS confirmed at the keyboard; the real phone's attempt then fails visibly |
| Stolen QR after use | useless | consumed; `psk` erased |
| Brute force of tokens / keys | infeasible | 256-bit randomness |
| Password guessing through the tunnel | locked out | per-device + per-username lockout in AuthStore |
| Compromise of hub static key later | past sessions safe | ephemeral `ee` (forward secrecy); rekey epochs |
| DoS (relay down, floods, mailbox full) | tunnel unavailable; LAN unaffected | rate limits, caps, fail-closed; the relay can always deny service |
| LAN attacker (Wi-Fi) reads the plain-HTTP mailbox traffic | nothing readable | same Noise tunnel; the mailbox carries only ciphertext and token hashes (section 16) |
| LAN attacker squats the hub's address / answers as the hub (ARP, rogue DHCP, rogue AP) | handshake fails; the phone never talks to it in clear | `HS_pub` pinned from the QR; DoS only |
| LAN attacker injects, replays or reorders frames | rejected / session ends | same as the relay rows |
| LAN attacker floods the mailbox | mailbox answers 429; web UI keeps its own listener budget | in-flight budget, rate limits, failed-auth lockout per socket address (section 16) |
| LAN attacker learns that a hub, a room and phones exist | yes | metadata (addresses, timing, sizes), as with the relay |
| Request smuggling via headers | no | header allowlist; hub sets Host, Cookie, User-Agent itself |
| XSS in the app | can use, not export, `DS`; cannot read the session cookie | non-extractable key; hub-side jar |

Metadata the relay does learn: the room exists, how many devices/channels,
when they are active, frame sizes (padded to 256 B), timing, IP addresses,
`pid` and device ids (random, in HS1 headers), and that a request/response
pattern is happening.

## 14. Residual risks

- A compromised **hub computer** or **unlocked phone with an active session** is
  out of scope.
- Traffic analysis: padding hides exact sizes only; timing and volume show.
- The relay can deny service at will; LAN is the fallback. A malicious relay can
  still make the hub spend bounded CPU and memory (the caps in section 12), but
  the LAN keeps working: the tunnel never blocks the LAN handler.
- All handshakes share one global rate limit (60/min). A relay, or anyone with a
  device token, can use it up and so delay legitimate phones' handshakes. Not
  fixed: it is denial of service only.
- Timing differences (for example how fast a handshake is refused for an unknown
  device versus a known one) are not equalised. They reveal at most what the
  relay already sees (that a device id exists in the room).
- Revoking a device ends its sessions and refuses its next frame, but does not
  interrupt a request handler already running for it: that handler finishes
  (its output is discarded).
- `devices.json` and `pairing.json` are updated under a lock file with stale-lock
  takeover after 10 s; two processes racing to take over the very same stale
  lock are not excluded. A damaged state file stops the tunnel (never silently
  replaced); the LAN keeps working.
- If the phone's clock is off by more than 10 minutes, handshakes are refused.
- LAN mode (section 16): metadata and bearer tokens are visible on the Wi-Fi, and a
  LAN attacker can deny service or squat the hub's address (the handshake then
  fails). The mailbox's failed-auth lockout is per socket address, so several
  phones behind one NAT address share it.
- A malicious app build (or a compromised WebView) defeats everything on the
  phone side.
- `pairing.json` holds `psk` for up to 10 minutes; anyone who can read the hub's
  files in that window can pair (still needs the SAS confirmation).
- No post-compromise security within one session beyond its 24 h lifetime: a
  thief of a live transport key reads that session until rekey/re-handshake
  (in-band REKEY derives from the current key).

## 15. Relay API (for the website; implement next to `lib/relay.ts`)

This API is implemented twice, with the same behaviour: by the website
(`lib/tunnelRelay.ts`, Redis or memory) and **also by the hub itself**
(`lib/hub/lanrelay.js`, memory only, one room: its own), under the same
`/api/tunnel/room/{roomId}` paths on the hub's LAN listener (section 16).

Everything here is opaque to the relay: it never decodes frame text. Use a
separate key namespace (`tun:`) from remote control (`rc:`); reuse the
Redis-REST / in-memory store pattern of `lib/relay.ts`; `runtime = "nodejs"`,
`maxDuration = 60`; every response `Cache-Control: no-store`, JSON body,
errors as `{"error": "<sentence>"}`. If no store is configured: 503, as
`relay.unavailable()`. Never log `Authorization` headers or request bodies.

### Tokens and ids

| Name | Format | Check |
|---|---|---|
| hub token | `^afth_[A-Za-z0-9_-]{43}$` | `H(token) == roomId` (constant-time) |
| client token | `^aftc_[A-Za-z0-9_-]{43}$` | `H(token)` in the room's allowlist, and that entry's `exp` absent or `> now` |
| `roomId` | `^[A-Za-z0-9_-]{43}$` (path) | |
| `ch` (channel) | `^[A-Za-z0-9_-]{22}$` | bound to the first client-token hash that used it |
| frame `c` | `^[A-Za-z0-9_-]{24,44000}$` | nothing else |

`H(t) = base64url(SHA-256(UTF-8 t))` without padding — the same as
`sessionId()` in `relay.ts` but base64url instead of hex. Auth header:
`Authorization: Bearer <token>`; missing/malformed/unknown → 401.

### Endpoints (base `/api/tunnel/room/{roomId}`)

**`PUT /api/tunnel/room/{roomId}`** — hub. Create the room or replace its allowlist.
Body ≤ 8 KB: `{"v":1,"clients":[{"h":"<43 chars>","exp":<ms epoch, optional>}]}`,
≤ 32 entries. Delete channels whose owner hash is no longer listed. Marks the
hub seen. → `200 {"ok":true}`; 400 bad body, 401, 413, 429.

**`GET /api/tunnel/room/{roomId}/hub?after=<int>&wait=<0..25>`** — hub long-poll.
Marks the hub seen (before and after waiting). Returns frames with
`seq > after`, ascending, ≤ 256, waiting up to `wait` seconds for the first one:
`200 {"frames":[{"seq":<int>,"ch":"<ch>","c":"<frame>"}],"head":<latest seq>}`.
The reply body MUST be ≤ 3 MB (return fewer frames, at least one, rather than
exceed it): the hub refuses a larger reply unread.
404 if the room is unknown (the hub then PUTs again and restarts at `after=0`).

**`POST /api/tunnel/room/{roomId}/hub`** — hub sends. Body ≤ 3 MB:
`{"frames":[{"ch":"<ch>","c":"<frame>"}]}`, ≤ 64 frames. Append each to its
channel's queue in order (per-channel `seq`, starting at 1). A frame for an
unknown channel is dropped silently. → `200 {"ok":true,"accepted":<n>}`; 400, 401, 404, 413.

**`POST /api/tunnel/room/{roomId}/client`** — phone sends. Body ≤ 800 KB:
`{"ch":"<ch>","frames":["<frame>", ...]}`, ≤ 16 frames. Bind `ch` to `H(token)`
on first use; a channel bound to another token → 403. ≤ 8 channels per token,
≤ 64 per room → 429. If the hub was not seen in the last 45 s → 409
`{"error":"the computer is offline"}` and nothing is stored. Otherwise append
each as `{seq, ch, c}` to the room's hub queue in order → `200 {"ok":true}`.
400, 401, 403, 404, 409, 413, 429.

**`GET /api/tunnel/room/{roomId}/client?ch=<ch>&after=<int>&wait=<0..25>`** —
phone long-poll; same auth and channel binding (binds if new). →
`200 {"frames":[{"seq":<int>,"c":"<frame>"}],"online":<hub seen < 45 s>,"head":<latest seq of this channel>}`,
≤ 256 frames, body ≤ 3 MB as above (the phone refuses a larger reply). 400, 401, 403, 404, 429.

CORS (the app runs at `https://localhost` / `capacitor://localhost`): the two
`/client` endpoints MUST answer `OPTIONS` preflights and send
`Access-Control-Allow-Origin` set to the request's origin ONLY when it is exactly
`https://localhost` or `capacitor://localhost` (with `Vary: Origin`), never `*`;
`Access-Control-Allow-Methods: GET, POST, OPTIONS`,
`Access-Control-Allow-Headers: Authorization, Content-Type`,
`Access-Control-Expose-Headers: Retry-After`, `Access-Control-Max-Age: 600`. Other
origins get no CORS headers. Auth is a bearer header, never a cookie, so this is
defence in depth rather than the control. The hub endpoints need no CORS.

### Limits and retention

| Item | Limit |
|---|---|
| hub queue | ≤ 1024 frames and ≤ 16 MB; oldest dropped first |
| channel queue | ≤ 512 frames; oldest dropped first |
| frame age | removed after 5 min |
| channel | deleted after 15 min without a request on it |
| room | deleted after 30 days without a hub request |
| rate | per token hash: 20 requests/s, burst 60 → 429 + `Retry-After` |
| failed auth | per client IP: 30/min → 429 |
| long-poll | `wait` clamped to 0..25 s |

Dropping frames is safe: the protocol detects the gap and re-handshakes.

### Redis layout (suggested; all keys expire with the retention above)

```
tun:<roomId>:m           hash  clients (JSON), hubSeen, created, hseq
tun:<roomId>:hub         zset  JSON {seq,ch,c} scored by seq
tun:<roomId>:chs         hash  ch -> JSON {owner, seen, seq}
tun:<roomId>:ch:<ch>     zset  JSON {seq,c} scored by seq
```

The in-memory store follows `memoryStore()` in `relay.ts` (globalThis map,
waiters woken on push). A relay restart resets sequence numbers; clients detect
it through `head < after` and restart from 0.

### Status codes summary

200 ok · 400 malformed request · 401 missing/bad/unknown token · 403 channel
bound to another token · 404 unknown room · 405 wrong method · 409 hub offline ·
413 body too large · 429 rate or count limit (`Retry-After`) · 503 relay not configured.

## 16. LAN mode: the same tunnel over the home network

The hub hosts a small, in-memory, relay-compatible mailbox (section 15, served by
`lib/hub/lanrelay.js`) on its own LAN listener. A phone on the same Wi-Fi uses
the hub's base URL (`http://<lan-ip>:<port>`) as its *relay* base URL and runs
exactly the protocol of sections 3–12 against it. Nothing about the keys, the
handshakes, the frames or the transport changes; only the carrier does.

### 16.1 What changes in the spec

- **5.1**: "the relay MUST be https" has a LAN exception: `http://` (or `https://`)
  to a **private IPv4 literal or a `.local` name** (and loopback, as before). `l`
  in the link is the hub's mailbox base URL, never a page. With the internet
  relay off, `r` = the LAN base URL and `rm` is still present.
- **15**: the Relay API is "also served by the hub itself". Differences for the
  hub-hosted mailbox: one room only (its own room id; `PUT` for any other room is
  403, and a hub request for another room is 404); the caller's identity for the
  failed-auth lockout is the socket's remote address (never `X-Forwarded-For`);
  extra memory bounds (a byte cap per channel queue, 8 MiB, and for all channel
  queues together, 32 MiB, oldest frames dropped first; bounded lockout and rate
  tables); a request budget (48 concurrent requests, 16 per address; over it,
  429 + `Retry-After`) so a flood against the mailbox cannot starve the web UI;
  its own body limits and idle-body deadline (8 s) as in section 15; a sweeper
  timer that does not keep the process alive. Frames and tokens are never parsed,
  logged or echoed. CORS is exactly as in section 15 (exact origins
  `https://localhost` and `capacitor://localhost`, never `*`); a preflight that
  asks for Private Network Access from an allowed origin is answered with
  `Access-Control-Allow-Private-Network: true`.
- **13/14**: the LAN rows above.
- **8**: unchanged. The hub's tunnel polls its own mailbox in-process (no HTTP
  hop, no token) and feeds the same session handling, the same per-device login
  lockout (`relay:<deviceId>`) and the same revocation (the allowlist is
  republished to the local mailbox on every change, within ~2 s, and on the next
  frame of a revoked device).

### 16.2 Who may reach it

The mailbox is mounted at `/api/tunnel/` in the hub's HTTP server **after** the
private-address gate (peer must be loopback or private, unless `--allow-remote`)
and the Host allowlist, and **before** the cookie/CSRF logic. It authenticates by
bearer token only: it never reads or sets a cookie, so there is no ambient
credential for CSRF to ride; the Origin/CSRF rules of the session API do not run
on it, and still run on every other route unchanged. A request that arrived
*through* the tunnel can never reach it. No token: 401.

### 16.3 Two carriers at once

The hub's tunnel can use the LAN mailbox and the internet relay simultaneously, or
either alone (the LAN mailbox does not need the internet relay). Both share one
room id, one set of keys and one allowlist. A session belongs to the mailbox its
HS1 arrived on: its frames go back on it, and frames for it that arrive from the
other mailbox are dropped (the rule "DATA must arrive on the channel that carried
its HS1" extends to the carrier). Outbound queues, caps and shedding are per
carrier.

Control: `arcflare phone lan on|off|status`. Default: on when the hub is started
with a non-loopback host (it accepts only private peers and carries ciphertext),
off with `--local`; an explicit `lan on|off` wins. `arcflare phone pair` prints
`l` = the LAN base URL whenever the LAN mailbox is on (`--lan-url` overrides the
address, `--no-lan` omits it), and `r` = the internet relay if it is on, else the
LAN base URL.

### 16.4 What LAN mode protects

- **Identity**: the hub is identified by its pinned public key from the QR. A
  device that answers at the hub's address without `HS` cannot complete a
  handshake; the phone sends it nothing but ciphertext it cannot use.
- **Confidentiality and integrity**: AES-256-GCM under X25519 keys; passwords,
  cookies, CSRF tokens, paths and bodies are never on the wire in clear, and the
  mailbox holds only ciphertext and token hashes. Forward secrecy and rekeying as
  in section 7.
- **Replay and reorder**: strict counters, HS1 ephemeral cache and timestamp,
  channel binding, as for the relay.
- **Pairing without internet**: the QR is scanned at the computer; the SAS is
  confirmed at the keyboard; the pairing token reaches the mailbox through the
  allowlist like any other.

### 16.5 What it does not protect

- **Metadata** visible to anyone on the LAN who can sniff it: that a hub and
  phones exist, their addresses, timing, and padded frame sizes; the bearer tokens
  in the `Authorization` header (plain HTTP). A token thief gets a mailbox seat
  only (denial of service at most), as in section 9.
- **Availability**: a LAN attacker can flood the mailbox (bounded: 429, lockout),
  jam the Wi-Fi, or **squat the hub's address** (ARP/DHCP/rogue AP) and answer in
  its place. The phone then fails the handshake (pinned key) or times out; it
  does not downgrade, fall back to a page, or send anything in the clear. Denial
  of service only.
- **A hostile phone-side page or app build**, and a compromised hub computer, as
  in section 14.
- Over plain `http` a LAN attacker can see which mailbox calls are made (paths,
  query strings: room id, channel id, `after`/`wait`). Those are random ids, not
  secrets that open anything beyond the mailbox.
