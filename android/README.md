# ArcFlare for Android

A thin [Capacitor](https://capacitorjs.com) app that reaches the hub started by `arcflare phone`.
Nothing here is a second hub: the app pairs with your computer, then runs the bundled copy of the phone UI
(`lib/hub/ui`) over the **encrypted tunnel** of `lib/hub/TUNNEL.md`, carried either by the hub's own mailbox on the
home network or by the internet relay. The WebView only ever shows bundled files (`https://localhost`); it never loads
a page from the hub. The hub itself stays zero-dependency; this folder has its own `package.json` and lockfile and does
not touch the root `package.json`.

**Status: nothing in the native layer has been compiled or run.** The machine this was written on has no
Android SDK (and `dl.google.com` is unreachable), so no APK was built and no emulator or phone was used.
Everything that is plain JavaScript is tested (including against the real hub's mailbox, see below), and the pure-Java
navigation rule is compiled and executed with `javac`; everything else is listed under
[Unverified on a real device](#unverified-on-a-real-device).

## What it does

1. **First run: pairing.** Run `arcflare phone pair` on the computer, scan the QR it prints with the phone's
   normal camera app. The link `arcflare://pair?...` opens ArcFlare through an intent filter (no camera
   permission, no scanner plugin). Or paste the link into the text box.
   **Any web page or app on the phone can fire an `arcflare://pair` link**: the intent filter is BROWSABLE, so a web
   page can open the app's pairing screen, as well as a camera app. (Whether dropping BROWSABLE would still let every
   QR scanner work is untested, so it was left.) Be honest about what that means: **someone who runs their own hub can
   approve their own pairing at their own keyboard**, so the approval at the computer proves nothing about whose
   computer it is. The only defence is the person comparing the fingerprint on the confirmation screen with the "hub key"
   their own computer printed, and reading the "Replace ..." wording when a pairing exists. That is a **residual
   phishing risk**, not a solved one. The steps below only add friction: a confirmation screen, a "Replace" step that
   asks you to **type the first 4 characters of the OLD fingerprint**, a lock on the Pair button, and approval of the
   new phone at the computer's keyboard.
2. **The link is validated first**, by the pure module `www/link.js`, before anything is stored or sent
   (TUNNEL.md 5.1): version exactly 1; `r` is an `https://` relay host name (never an IP literal, no user info, query
   or fragment), or, when the internet relay is off, exactly the same LAN base as `l`; `l` is the hub's LAN mailbox
   base `http://<192.168/16, 10/8 or 172.16/12 address, or name.local>:<port>` with an explicit port 1..65535 that is
   **not 80 or 443**, no user info, path, query or fragment; exact base64url shapes for room/hub key/secret, no
   unknown/duplicate/oversized parts. `l` is a base URL for the mailbox API, **never a page to open**. Any problem: a
   plain message, nothing stored.
3. **Confirmation screen** with the hub-key fingerprint (same value `arcflare phone pair` prints as "hub key"), the
   relay host and the home-network address. If a pairing already exists it reads **"Replace the computer
   `<old fingerprint>` with `<new fingerprint>`?"**. The Pair button is disabled for 1.5 s after the screen renders. While the
   confirmation or code screen is up, further incoming links are **ignored** (a notice says so); the pending pairing is
   bound to the exact link text that started it and is re-verified on the Pair click. Cancel stores nothing.
4. **Pair** runs `ArcFlareTunnel.pair()` (home network first, relay if that fails) and shows the 6-digit code; confirm it
   **on the computer**. The new device lives **in memory only** until "I confirmed it" succeeds (a real handshake that
   the hub accepts as approved); only then is it saved, replacing the old pairing. Cancel or any failure leaves the old
   pairing untouched. (If the app is killed in between, the new device is lost; the computer deletes unapproved
   devices after 15 minutes.)
5. **Every launch** (`www/mode.js`, `www/connector.js`): the pairing record keeps both bases from the link, `lan` (= `l`)
   and `relay` (= `r`; equal to `lan` when the internet relay is off).
   - **Home first:** a real tunnel handshake against the hub's mailbox at `lan`, capped at 3 s, through the native LAN
     fetch (below). It succeeds only if the hub answers with the pinned hub key, so success proves the hub's identity.
     Then the bundled UI starts over that tunnel, chip **"Home network"**. **The relay is never contacted then.**
   - **Relay only if home failed** and `relay` differs from `lan`: handshake over `https`, capped at 10 s; bundled UI over
     the relay, chip **"Relay"**.
   - Otherwise "Can't reach your computer" with Retry, Re-pair and Forget this computer. (A home handshake answered
     with "not approved yet" ends the search with an explanation; the relay would say the same.)
   The UI page connects again by itself when its session ends (hub restart, 24 h limit, network change): home first
   again, so the chip follows the phone from relay to home network and back.
6. **The WebView never navigates to the hub.** There is no probe of `/api/status`, no cookie of a hub page, no plain-http
   page. The native guard refuses every top-level navigation away from `https://localhost`, with no exception that can be
   set (see Security design for what it covers and what it cannot).
7. **Forget** awaits every wipe step (all IndexedDB databases, Web Storage, Cache Storage, all cookies through
   Capacitor's native cookie manager, which also removes HttpOnly cookies) and re-checks. If any step failed it says which
   and **does not claim success**: you stay on the Forget screen, can try again, or clear the app's data in Android
   Settings. The computer keeps listing the phone until `arcflare phone devices revoke <id>`.
8. **Getting back to settings.** The hub UI has no settings page, so the shell is a history entry behind it:
   Android Back from the hub UI's first screen returns to the shell, which then shows a "This computer" screen
   (Open / Re-pair / Forget) instead of jumping forward again.
9. **No X25519, no app.** If the WebView cannot do X25519 (older than Chromium 133) the shell shows "Update Android System
   WebView" and does nothing else: no pairing, no connecting, links ignored. Capacitor's `android.minWebViewVersion` is
   133 with a bundled error page (`server.errorPath`), because without that page Capacitor only logs the problem and
   loads the app anyway.

Records from earlier builds with a LAN address the new rules refuse (https, port 80/443) show the pairing screen again:
pair once more.

## Layout

```
android/
  package.json, package-lock.json   exact pins: @capacitor/core, android 8.5.3; app 8.1.2; cli 8.5.3 (devDependency)
  capacitor.config.json             minWebViewVersion 133, errorPath webview-error.html, CapacitorHttp/Cookies patching off
  www/                  the web app Capacitor ships
    index.html shell.js shell.css      shell screens (pairing, confirm, code, unreachable, forget)
    webview-error.html    shown when the WebView is too old (no script)
    link.js               PURE link validator (r, l, LAN exception)   mode.js   PURE launch decision (home|relay|unreachable|unpaired)
    linkgate.js           PURE age/foreground check for retained links   fingerprint.js   hub-key fingerprint
    lanfetch.js           the tunnel client's injectable fetch for the LAN (CapacitorHttp, exact LAN base only)
    connector.js          connect/pair over home then relay (injected deps)   store.js   IndexedDB pairing record + honest wipe
    transport.js          tunnel -> ArcFlareTransport    native.js   Capacitor bridge wrappers (no navigation plugin)
    relay-boot.js relay-chip.js        run in the bundled UI page (connect home-first, chip)
    ui/  vendor/          GENERATED by scripts/sync-ui.js, never committed
  scripts/sync-ui.js      copies an explicit allowlist of lib/hub/ui files (no symlinks, CSP asserted inside <head>) to www/ui, builds the tunnel-mode index.html, copies Capacitor's runtime
  android/                the native Android project (generated by `npx cap add android`, then hardened)
    .../NavPolicy.java    the navigation rule (pure Java, run by test/navpolicy.test.js)   .../MainActivity.java   WebView client
  test/                   node:test tests + Playwright shell.e2e.js
```

## Build

### CI (the supported way)

`.github/workflows/android.yml` has two jobs. The release signing key is reachable only from the second one.

- **`build`** (push to main, pull requests, manual runs, tags): **no secrets at all**, `permissions: contents: read`.
  `npm ci --ignore-scripts`, `npm test`, `sync-ui`, `npx cap sync android`, then `assembleDebug` and an
  **unsigned** `assembleRelease`. Uploads only `*.apk` (`arcflare-debug-apk`, `arcflare-unsigned-release-apk`).
  Pull requests and branches never sign anything, and no workflow uses `pull_request_target`.
- **`release`** (only `push` of a tag `v*`; `needs: build`; `environment: android-release`;
  `permissions: contents: read`): checks out the exact tagged commit, no dependency cache, installs with
  `--ignore-scripts`, decodes the keystore as the last step before the signing build, runs
  `assembleRelease`, deletes the keystore under `always()`, uploads only the signed `app-release.apk`
  (`arcflare-release-apk`). It fails if the keystore secret is missing instead of producing an unsigned build.

Both jobs run `gradle/actions/wrapper-validation` before any `./gradlew`, and the wrapper's Gradle distribution is
pinned with `distributionSha256Sum` (8.14.3 `-bin`, from Gradle's official release-checksums page; the committed
`gradle-wrapper.jar` matches the published wrapper checksum). Every action is pinned by full commit SHA with the tag
in a comment; `android/test/workflow.test.js` checks that, the job split, and that no secret appears outside `release`.

**Repository owner setup (required, not done by the repo):**
1. Settings > Environments > create `android-release`, add **required reviewers** (and restrict deployment to tags
   `v*`). The reviewer must check that the tagged commit is the reviewed one.
2. Store `ANDROID_KEYSTORE_BASE64` (`base64 -w0 release.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
   `ANDROID_KEY_PASSWORD` as **environment secrets of `android-release`**, not repository secrets (repository
   secrets are available to any workflow on any branch).
3. Add a tag ruleset for `v*` so only trusted maintainers can create tags.

The `release` job still runs the tagged commit's Gradle build scripts with the key available, so a tag must only be
approved after reviewing that commit. Gradle dependency verification (`verification-metadata.xml`) is **not done**:
it cannot be generated offline here, so Maven dependencies are not hash-checked yet.

### Locally (needs the Android SDK, JDK 21)

```
cd android
npm ci
node scripts/sync-ui.js          # or: npm run sync-ui
npx cap sync android
cd android && ./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
```

Release signing locally: export `ARCFLARE_KEYSTORE` (path), `ARCFLARE_KEYSTORE_PASSWORD`,
`ARCFLARE_KEY_ALIAS`, `ARCFLARE_KEY_PASSWORD`, then `./gradlew assembleRelease`. Without them no signing
config exists and the release build is unsigned (not installable).

### Tests (run anywhere with Node 22)

```
npm test            # node:test: link, mode, connector, lanfetch, store, shell, native.js, NavPolicy (compiled with javac), hub integration, hygiene
npm run test:e2e    # Playwright + Chromium with a fake Capacitor bridge and fake tunnel (skips if absent)
```

## Install the APK

Download `arcflare-release-apk` (or `arcflare-debug-apk`) from the workflow run's artifacts, unzip, copy the
`.apk` to the phone and open it (allow "install unknown apps" for your file manager or browser once), or with
USB debugging on: `adb install app-release.apk`. Requirements: Android 8.0+ (minSdk 26) and
**Android System WebView / Chrome 133 or newer** (WebCrypto X25519). Capacitor's `android.minWebViewVersion` is 133
(with a bundled error page), and the shell refuses to start without X25519; it never falls back to a weaker scheme. Debug builds are signed with the
debug key and are for testing only.

## Security design

- **Pairing secret.** `ps` exists only in the pasted/launch link and, as a re-built canonical link made from the values
  `link.js` accepted, in `connector.js` on its way to `pair()`. It is never stored, logged or put in a URL; the paste box is
  cleared on submit and the clipboard is overwritten with an empty string (best effort). The bases stored are the ones
  `link.js` accepted, not whatever the tunnel client parsed. `loggingBehavior` is `none`. A test fails if any other shell
  file touches the secret.
- **Where things live.** `tunnel-client.js` itself stores nothing (checked by a test). The shell keeps one record in
  IndexedDB (`arcflare-pairing`): `relay` (= link `r`), `lan` (= link `l`), room, hub key, device id, room token, label and
  the device key, which the tunnel client generates **non-extractable** (script can use it, not read it out; see
  Residual risks for what that does and does not protect). No `localStorage`, `sessionStorage`, cookies, URLs or logs:
  `test/hygiene.test.js` scans the shell sources and fails on any of them. Android backup is off (below).
- **Hub key pinned**, fingerprint shown before pairing; SAS code shown after; approval only at the computer's keyboard
  (TUNNEL.md 5.3). A hub, relay or LAN squatter answering with another key fails the handshake. This is what makes the
  plain-http LAN carrier acceptable: nothing readable travels on it and a stranger at the hub's address cannot pass
  as the hub (TUNNEL.md 16.4).
- **Replace, don't overwrite (review finding M1).** Pairing never touches an existing pairing before the new one has been
  approved at the computer; see "What it does" 3 and 4. Retained links are dropped when older than 5 minutes or when they
  predate the app being brought to the foreground by more than 2 s (`linkgate.js`); a launch URL that Android re-delivers
  from a restored task cannot be aged (Residual risks).
- **Stolen phone, revocation.** `arcflare phone devices revoke <id>` on the computer cuts the phone off (TUNNEL.md 10);
  the phone then sees "The relay no longer accepts this phone". The session cookie never reaches the phone.
- **No downgrade.** Links with `v` other than 1 are refused; there is one suite (TUNNEL.md 11); no X25519 means no app.
- **The LAN fetch (`www/lanfetch.js`).** The bundled page runs at `https://localhost` and cannot fetch `http://<lan-ip>`
  (mixed content, CORS). `tunnel-client.js` has an injectable `fetch` option (`connect(device, { fetch })`,
  `pair({ fetch })`); the shell supplies one built on Capacitor's native `CapacitorHttp`, for **one kind of request only**:
  GET or POST to exactly `<stored LAN base>/api/tunnel/...` (same scheme, host and port; no user info, fragment, dot
  segments or encoded slashes). Everything else is refused before it reaches the native layer. Only `Authorization`,
  `Content-Type` and `Accept` are sent (no `Cookie`), every `Set-Cookie` of an answer is dropped, redirects are off and any
  3xx is an error, native timeouts are 3 s connect and 40 s read (25 s long polls), answers over 3 MB are refused,
  at most 8 requests are in flight, and an aborted request rejects at once while a late native answer is ignored
  (the native plugin cannot cancel). The restriction is JavaScript-level; see Residual risks.
- **CSP on bundled pages** (meta tag, because bundled files have no headers):
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; base-uri 'none'; form-action 'none'`.
  **Tradeoff of `connect-src https:`:** the relay is a user-configurable host (`arcflare phone relay on <url>`), so the
  policy cannot name it. It means a script that ever ran in the page could talk to any https host. It cannot get at the
  device key (non-extractable) or the cookie (kept on the hub), and nothing but our own files may run (`script-src 'self'`,
  no inline script). Tightening it to one host is possible if you only use one relay: edit the CSP in `www/index.html` and
  `scripts/sync-ui.js`. There is no `http:` source: page script cannot make cleartext requests; only the LAN fetch does,
  natively.
- **Navigation guard (native).** The WebView may show `https://localhost` and nothing else. `NavPolicy.allows(String)` judges
  the raw URL against one exact pattern (literal `https://localhost`, optionally followed by `/`, `?` or `#` and characters
  that are not backslash, whitespace or control characters), not `android.net.Uri`, because Chromium and `Uri` disagree on
  backslashes. There is no setter, plugin or stored exception (the old `NavGuard` plugin and its `setLan` are gone).
  `MainActivity.GuardedClient` applies it in four places: `shouldOverrideUrlLoading` (both overloads; links, `location`,
  `window.open`, redirects), `shouldInterceptRequest` for **main-frame** requests (also sees POST submissions and history
  navigations, answered with an empty 403 before any network), and `onPageStarted` / `onPageFinished` (a foreign URL that
  still became current is stopped and the app is reloaded). Nothing is ever handed to a browser or another app.
  **What it cannot cover:** same-document changes (URL hash), subframes and subresources (the bundled CSP has no
  `frame-src` and no `http:` in `connect-src` instead), anything Android does not report to these callbacks, and whether
  these callbacks fire as documented on every WebView version (not run). `NavPolicy.java` itself is real: `test/navpolicy.test.js`
  compiles it with `javac` and runs vectors plus 30 000 fuzz URLs against Node's WHATWG URL parser.
- **Native hardening** (all in `android/app/src/main`, each line commented): `allowBackup=false` plus
  `dataExtractionRules`/`fullBackupContent` excluding every domain; release `debuggable false`; WebView debugging off in
  every build (`webContentsDebuggingEnabled:false`, so debug builds cannot be inspected with chrome://inspect either);
  `allowFileAccess`/`allowContentAccess` off; `importantForAutofill=noExcludeDescendants` on the WebView so the system does
  not offer to save the hub password; only the launcher activity is exported, the template FileProvider is removed,
  the only permission is INTERNET; the intent filter is `arcflare://pair` only (no https app links); `FLAG_SECURE`
  (no screenshots, blank recents thumbnail); system CAs only; minSdk 26; minimum WebView 133.
- **Cleartext.** `network_security_config.xml` permits cleartext for **every host**. It cannot be limited to private addresses
  (the config matches host names, not CIDR ranges, and the hub's address is whatever the router handed out). The exposure
  is limited by what the app does, not by the config: the WebView can no longer navigate to a cleartext page (above), the
  bundled CSP has no `http:` source, and cleartext requests are made only by native code on behalf of `lanfetch.js`, to
  the stored LAN base's `/api/tunnel/` paths. What a Wi-Fi neighbour sees there is ciphertext frames, bearer tokens and
  mailbox metadata (TUNNEL.md 16.5), not passwords, cookies or pages.
- **LAN without a certificate.** The app does **not** use or accept an https LAN address (and `--cert/--key` on the hub
  does not give this app a protected LAN page: it never loads one). The LAN carrier is protected by the tunnel itself:
  pinned hub key, AES-GCM, strict counters. Choose the relay or no LAN if you cannot accept the metadata exposure below.

### Residual risks (read with TUNNEL.md sections 13, 14 and 16.5)

- A malicious app build or compromised WebView defeats everything on the phone side. Only install builds you made.
- **Never distribute debug APKs.** The device key is non-extractable only against page script. A debug APK is debuggable:
  `adb run-as net.arcflare.app` can read the IndexedDB files (and, on a rooted phone or with a stolen unlocked device, so
  can anyone), and a non-extractable `CryptoKey` in IndexedDB is only as safe as the app's private storage.
- **The plain-HTTP LAN mailbox leaks metadata and its bearer token to a sniffer** on the same Wi-Fi (or to whoever answers at
  the stored LAN address): that a hub and phones exist, addresses, timing, padded frame sizes, mailbox paths and ids, and the
  `Authorization` header. That header carries the device's **LAN token**, a separate per-device token that is valid on the
  hub's LAN mailbox ONLY: it is not valid on the internet relay, and the relay token is never sent to the LAN
  (TUNNEL.md 9, 16.5, 16.6). A thief of the LAN token can deny service on the LAN mailbox (occupy the device's channels,
  send junk) and nothing else; the phone's relay path is untouched. A LAN attacker can also flood, jam, or squat the hub's
  address; the handshake then fails (DoS only). The mailbox's failed-auth lockout is per socket address, shared by phones
  behind one NAT, and only answers tokens that were presented and are wrong.
- **Phones paired by an earlier build have no LAN token** and work through the relay only. The app says "Re-pair to use the
  home network" (and, for a home-network-only pairing, that it cannot connect until the phone is paired again). Pair once
  more to get a LAN token; there is no silent upgrade.
- **Cookies from an earlier build.** A phone that ran an earlier build may hold an `arcflare_sid` cookie for the hub's LAN
  address in Android's native cookie jar, which Capacitor's default Java cookie handler would send in clear. This build
  clears the native cookie jar ONCE on its first start (a marker in IndexedDB, written only after the clear succeeded),
  before it talks to the LAN. As a backstop `NavPolicy` refuses any URL containing Capacitor's
  `/_capacitor_http_interceptor_` path in any spelling.
- **Capacitor's `CapacitorHttp` and `CapacitorCookies` JavaScript interfaces exist on the bundled origin**
  (`CapacitorHttpAndroidInterface`, `CapacitorCookiesAndroidInterface`, plus the plugins reachable over Capacitor's bridge).
  They cannot be removed without patching Capacitor; `enabled:false` only stops `fetch`/`document.cookie` patching. So the
  "only the stored LAN base" rule of `lanfetch.js` is a rule of our JavaScript: script running in the bundled origin
  (which `script-src 'self'` should prevent) could call `CapacitorHttp` for any URL, including cleartext ones, and
  `CapacitorCookies` can set cookies for any URL. `CapacitorCookies.load()` also installs a default Java `CookieHandler`
  whatever the config says, so the native HTTP stack may send or store cookies of the WebView's cookie manager for the LAN
  address; the hub's mailbox never reads or sets cookies and Forget clears them, but we cannot prove none are sent.
- The native HTTP plugin buffers a whole answer before our 3 MB cap can apply, and runs requests on an unbounded thread pool.
- On a WebView without `WEB_MESSAGE_LISTENER` support, Capacitor falls back to exposing `androidBridge` to every origin.
  Android WebView/Chrome 133 or newer has it, and the shell refuses to run without X25519 (also 133+). Capacitor applies
  `minWebViewVersion` to every WebView package except Huawei's, which has its own number (`minHuaweiWebViewVersion`, left at
  Capacitor's default, so a Huawei WebView is only stopped by the X25519 gate).
- Pairing links can reappear: if Android restores the task from recents with the original VIEW intent, `getLaunchUrl()`
  delivers the old link again and the shell has no timestamp for it. It shows the confirmation screen (with "Replace"
  wording if you are paired); it cannot do anything unless you press Pair and then approve on the computer, and the link
  is one-time and expires after 10 minutes.
- **The native navigation guard has gaps** (see Security design): hash changes, subframes/subresources, and any navigation
  Android does not report; its callbacks have not run on a device.
- The hub restarting resets the mailbox's sequence numbers and ends sessions. The client detects `head < after` and restarts
  from 0, then re-handshakes; the UI signs in again because the hub's cookie jar is in memory (TUNNEL.md 8, 15).
- Newer Android releases are adding a runtime "local network" permission for apps that talk to LAN addresses. The manifest
  declares only INTERNET; if a device version enforces that permission, the home path would fail (and the relay would be
  used). Not checked.
- `.local` names depend on the phone's resolver doing mDNS for native HTTP; private IPv4 literals do not.
- One phone-to-hub handshake happens in the shell check and another when the UI page opens its own session: two
  handshakes per launch (well inside the hub's 60/min limit).
- Launcher icons are the panda on a dark tile, generated once with PIL, not designed icons.

## Contract notes (UI agent, `window.ArcFlareTransport`)

The adapter (`www/transport.js`) is built on `Tunnel.request()` / `Tunnel.eventSource()` and does not modify
`tunnel-client.js`; the connection (`relay-boot.js` + `connector.js`) decides which base the tunnel talks to:

- `fetch` returns `{ok, status, statusText, headers.get(), json(), text()}`; it does not use `tunnel.fetch()` so it never
  depends on a global `Response`. Only Accept, Content-Type and X-CSRF-Token are passed on; `credentials` is ignored.
  Paths must start with a single `/`.
- `tunnel.eventSource` has **no `addEventListener`**: the wrapper adds `addEventListener`/`removeEventListener`. Unnamed
  events reach `onmessage` and "message" listeners. tunnel-client only ever emits unnamed events, so listeners for named
  types are accepted and never fire (the hub sends only unnamed events). A stream whose session is unavailable gets one
  asynchronous `onerror` and `readyState 2`; **there is no retry in the adapter**, the UI does `/api/me` and backoff.
- The session opens lazily on first use, concurrent calls share one connect, and after `onclose` the next call opens a
  new one (home first, then relay). A GET/HEAD that hits a just-closed session reconnects once; a POST is never retried.
- `window.arcflareSetConnection("home" | "relay")` is called by `relay-boot.js` after each successful connect;
  `relay-chip.js` sets the initial chip once `app.js` has defined it (`?via=` from the shell, default "home").
- tunnel-client's `Mailbox` rejects with `PENDING`, `OFFLINE`, `REFUSED`, `TIMEOUT`, `HANDSHAKE`; the shell turns these
  into plain sentences.
- Hub contract problems found while doing this (hub files untouched except the one L4 change): `arcflare phone pair` accepts
  `--lan-url` values this app refuses (https, a path, loopback/`localhost`, ports 80/443), and always prints an `http://`
  LAN base even if the hub was started with `--cert/--key` (a TLS listener would not answer plain http); the app then
  rejects the link or fails the home handshake and falls back to the relay. `tunnel-client.js` now enforces a 1 s floor
  between polls after an early empty answer (L4), so the hub's copy and `www/ui/tunnel-client.js` change together.

## Unverified on a real device

Nothing below was compiled or executed against Android. Check each on a real phone (Android 8+ with WebView 133+):

1. **The whole Gradle/AGP build.** The project is the unmodified `npx cap add android` output (Capacitor 8.5.3, AGP 8.13,
   Gradle 8.14.3 wrapper, compileSdk/targetSdk 36 = the Capacitor default) plus the changes below.
2. `variables.gradle`: `minSdkVersion` 24 -> **26**.
3. `app/build.gradle`: `debuggable false` in `release`; optional `signingConfigs.release` read from `ARCFLARE_*` env vars.
4. `AndroidManifest.xml`: `allowBackup="false"`, `dataExtractionRules`, `fullBackupContent`, `networkSecurityConfig`;
   second intent filter on `MainActivity` for `arcflare://pair` (VIEW/DEFAULT/BROWSABLE, no `autoVerify`); FileProvider and
   `file_paths.xml` **removed** (check nothing in Capacitor needs it at build time).
5. `res/xml/network_security_config.xml` (cleartext allowed for all hosts, system CAs only), `data_extraction_rules.xml`,
   `backup_rules.xml` (the `<exclude domain="...">` lists are accepted by the Android 12+ and <=11 parsers).
6. **`MainActivity.java` and `NavPolicy.java` compile and behave.** `NavGuardPlugin.java` was **deleted** and
   `registerPlugin` removed (check nothing else registers or calls "NavGuard"). New in this file: `setImportantForAutofill(
   IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS)`, a `GuardedClient` with both `shouldOverrideUrlLoading` overloads, a
   `shouldInterceptRequest` override (403 for foreign main-frame requests, `super` otherwise), and `onPageStarted` /
   `onPageFinished` overrides that skip `super` and `loadUrl("https://localhost/")` for a foreign URL. **Verify** that
   Capacitor's asset serving at `https://localhost` is unaffected (the override delegates to `BridgeWebViewClient`), that the
   first page load is not blocked, that the `WebResourceResponse` constructor call is accepted, and that the
   `onPageStarted` redirect cannot loop. Only the logic of `NavPolicy.allows` was executed (javac + java, here).
7. **Navigation guard coverage on a device:** that `location.assign("http://192.168.x.x:8765")`, `window.open`, a link click
   and a server redirect reach `shouldOverrideUrlLoading` and open nothing; that a POST form submit and a history
   navigation to a foreign URL are caught by `shouldInterceptRequest` (they are not reported to `shouldOverrideUrlLoading`);
   what happens for `target=_blank` / multiple windows, and that the hash/same-document and subframe gaps are as described.
8. **`CapacitorHttp` as used by `lanfetch.js`:** that `get`/`post` honour `disableRedirects`, `connectTimeout`/`readTimeout`
   (the 25 s long polls), `responseType: "text"` and `shouldEncodeUrlParams: false`; that a POST with `data` as a JS object and
   `Content-Type: application/json` sends exactly that JSON; that `application/json` answers arrive already parsed (the code
   re-serialises them), that a 3xx comes back as a status rather than a thrown error, header-name casing of answers, and
   that errors (connection refused, timeout) reject. That cleartext to the hub's LAN address is permitted by the config
   and not blocked by the phone's own network policy, and that **no cookie** is sent or stored (the default `CookieHandler`
   caveat above).
9. **Real tunnel over a real LAN** between a phone and `arcflare phone`: pairing (home first), launch (home, then relay),
   `.local` name resolution, and the chip following the network. Only Node-side integration was run (`test/lan-integration.test.js`:
   real hub mailbox and real tunnel client with a fake native HTTP stack, including the `Host` header a phone would send).
10. **Deep links:** scanning the QR with the stock camera app opens ArcFlare; cold start uses `App.getLaunchUrl()`, warm start
    `appUrlOpen`; `App` `appStateChange` and the WebView's `visibilitychange` fire when the app is foregrounded (the 5 minute /
    foreground rule of `linkgate.js` depends on them); the camera app/Google Lens might show the link as text to tap; whether
    removing the BROWSABLE category (which would stop web pages from launching the link) still works with the stock scanners.
11. **`App.getLaunchUrl()` after Back:** the shell skips the launch URL when the page was reached by history Back
    (`navigation.type === "back_forward"`); confirm Android's WebView reports that.
12. **Capacitor injection under the CSP:** the bridge is injected as a document-start script (WebView 133+ supports it). On
    the old fallback (inline `<script>`) the CSP would block it. Also that the bridge (and so `CapacitorHttp`) is available to
    the bundled UI page at `https://localhost/ui/index.html` (the page loads `vendor/capacitor.js` and `native.js`).
13. **`android.minWebViewVersion` 133 and `server.errorPath`:** that an older WebView really shows `webview-error.html` and
    that a main-frame load error does not loop on it.
14. **`CapacitorCookies.clearAllCookies`** really removes every cookie (including HttpOnly) even with
    `plugins.CapacitorCookies.enabled: false`; Forget reports a failure if it throws.
15. **WebCrypto X25519 inside the real WebView**, IndexedDB persistence of the non-extractable `CryptoKey` across app restarts and
    updates, and that Android auto-backup/device transfer really exclude it.
16. **FLAG_SECURE** hides the password screen in screenshots and recents (it does not cover dialogs, the keyboard or autofill
    popups); `importantForAutofill` stops the autofill save prompt; `webContentsDebuggingEnabled:false` in debug and release.
17. **Install and signing:** the release APK signs and installs; icons render (generated, not designed).

## What the tests cover (and not)

`cd android && npm test` runs 290 `node:test` tests and `npm run test:e2e` 19 Playwright checks (counts at the time of writing):

- `link.test.js`: the hub CLI's own link accepted; **123 rejected inputs** (89 general hostile links plus 34 LAN-exception
  cases: public/0.0.0.0/link-local/127.x/IPv6 literals, `.local` look-alikes, ports 0/80/443/65536, user info, paths, `r`/`l`
  mismatches, https IP relays), canonical round-trips, a fuzz.
- `mode.test.js`, `connector.test.js`: the home / relay / unreachable / unpaired decision and the order of attempts (the relay is
  not contacted when home worked; PENDING ends the search; relay == LAN is one attempt).
- `lanfetch.test.js` (fake CapacitorHttp): wrong host/port/scheme/path refused, redirect refused, oversize refused, abort
  semantics (late results ignored), no cookie headers sent, Set-Cookie dropped.
- `lan-integration.test.js`: the real hub mailbox, the real shipped tunnel client, this app's modules, a fake native stack that does
  real HTTP.
- `shell.test.js` (the real `shell.js` against the ids of the real `index.html`, fake bridge/store/tunnel, fake clock): regression
  tests for each of the three M1 races from the review, the Pair-button lock, stale links, launch order, WebView gate, Forget.
- `store.test.js`: Forget awaits every step and reports failures; `navpolicy.test.js`: **the real `NavPolicy.java` compiled and run
  with javac** (skipped loudly without a JDK); `native.test.js`: `native.js` in a vm.
- `hygiene.test.js`: storage hygiene scans of the shell sources, config checks, and **"native source lint"**: greps over
  `MainActivity.java`, the manifest and the XML files. **Those are greps only**: they confirm the files say what they should and cannot
  catch an inverted condition. The navigation rule is covered by the javac test; the Android callbacks are not run at all.
- `shell.e2e.js`: the shell and the bundled UI page in Chromium with a fake Capacitor bridge and fake tunnel client; it also checks
  the WebView never requests the LAN address itself.

They prove the JavaScript logic, the wire contract with the hub's mailbox, and that the native files say what they should; they
cannot prove that Android accepts or runs them.
