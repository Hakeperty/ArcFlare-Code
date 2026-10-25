"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

const b64u = (b) => Buffer.from(b).toString("base64url");

/** A link built by the HUB's own pairingLink(), so the app is tested against what the CLI really prints. */
function hubLink(over = {}) {
  const { pairingLink } = require(path.join(__dirname, "..", "..", "lib", "hub", "tunnel.js"));
  const hubPub = over.hubPub || crypto.randomBytes(32);
  return pairingLink({
    relay: over.relay || "https://arcflare.net",
    roomId: over.roomId || b64u(crypto.randomBytes(32)),
    hubPub,
    secret: over.secret || b64u(crypto.randomBytes(32)),
    lan: "lan" in over ? over.lan : "http://192.168.1.20:8765",
  });
}

const A43 = b64u(Buffer.alloc(32, 7));   // a valid 43-char canonical value

module.exports = { b64u, hubLink, A43 };
