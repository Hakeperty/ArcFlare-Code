package net.arcflare.app;

import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Remembers the ONE LAN origin (scheme + host + port) the WebView may navigate to.
 * Memory only: the shell sets it on every launch from its own storage and clears it on Forget.
 * It is a Capacitor plugin, so it travels over Capacitor's bridge, not a new JavaScript interface.
 */
@CapacitorPlugin(name = "NavGuard")
public class NavGuardPlugin extends Plugin {

    // "http://192.168.1.20:8765" or null when no LAN origin is allowed.
    private static volatile String lanOrigin = null;

    @PluginMethod
    public void setLan(final PluginCall call) {
        // WebView.getUrl() must run on the UI thread.
        getActivity().runOnUiThread(() -> {
            // Only the bundled page may change the allowed origin.
            String page = getBridge().getWebView().getUrl();
            if (page == null || !page.startsWith("https://localhost/")) {
                call.reject("refused");
                return;
            }
            String url = call.getString("url", "");
            if (url == null || url.isEmpty()) {
                lanOrigin = null; // clear
                call.resolve();
                return;
            }
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            boolean schemeOk = "http".equals(scheme) || "https".equals(scheme);
            boolean shapeOk = u.getHost() != null && u.getPort() >= 1 && u.getPort() <= 65535
                && u.getUserInfo() == null && u.getQuery() == null && u.getFragment() == null
                && (u.getPath() == null || u.getPath().isEmpty() || "/".equals(u.getPath()));
            if (!schemeOk || !shapeOk) {
                call.reject("bad url");
                return;
            }
            lanOrigin = originOf(u);
            call.resolve();
        });
    }

    private static String originOf(Uri u) {
        return u.getScheme().toLowerCase() + "://" + u.getHost().toLowerCase() + ":" + u.getPort();
    }

    /** True for the bundled origin (https://localhost) or exactly the stored LAN origin. */
    static boolean allows(Uri u) {
        if (u == null || u.getScheme() == null || u.getHost() == null) return false;
        if ("https".equalsIgnoreCase(u.getScheme()) && "localhost".equalsIgnoreCase(u.getHost()) && u.getPort() == -1) return true;
        String lan = lanOrigin;
        return lan != null && u.getPort() != -1 && lan.equals(originOf(u));
    }
}
