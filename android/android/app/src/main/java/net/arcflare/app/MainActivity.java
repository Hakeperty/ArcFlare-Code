package net.arcflare.app;

import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Our only custom plugin (it must be registered before super.onCreate).
        registerPlugin(NavGuardPlugin.class);
        // No screenshots, no screen recording, blank thumbnail in the recents screen.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        super.onCreate(savedInstanceState);
        // The app never needs file:// or content:// access from the WebView.
        WebSettings settings = bridge.getWebView().getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // Pin top-level navigation (see GuardedClient).
        bridge.setWebViewClient(new GuardedClient(bridge));
    }

    /** Allows only the bundled origin and the stored LAN origin; refuses everything else and opens nothing. */
    private static class GuardedClient extends BridgeWebViewClient {
        GuardedClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !NavGuardPlugin.allows(request.getUrl()); // true = handled here = blocked
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !NavGuardPlugin.allows(Uri.parse(url)); // pre-API-24 style callback, same rule
        }
    }
}
