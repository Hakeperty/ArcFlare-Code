// Runs after app.js in the bundled UI page: the chip says "Home network" or "Relay" (relay-boot.js keeps it current).
if (typeof window.arcflareSetConnection === "function") window.arcflareSetConnection(window.ArcFlareConnection || "home");
