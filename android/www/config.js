// Build-time switches. Production builds keep allowLoopbackDev false:
// an http:// relay is then always refused.
window.ARCFLARE_CONFIG = Object.freeze({ allowLoopbackDev: false, probeTimeoutMs: 2000 });
