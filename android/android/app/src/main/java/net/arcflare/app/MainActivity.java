package net.arcflare.app;

import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.util.HashMap;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // No screenshots, no screen recording, blank thumbnail in the recents screen.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        super.onCreate(savedInstanceState);
        WebView webView = bridge.getWebView();
        // The app never needs file:// or content:// access from the WebView.
        WebSettings settings = webView.getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // The hub password is typed into the bundled page: keep the system autofill service from offering to save it.
        webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        // Navigation guard (see GuardedClient and NavPolicy): the WebView only ever shows https://localhost.
        bridge.setWebViewClient(new GuardedClient(bridge));
    }

    /**
     * Refuses every top-level navigation away from the bundled origin and opens nothing (no browser, no other app).
     * Layers, because no single Android callback sees every kind of navigation:
     *  1. shouldOverrideUrlLoading (both overloads): link clicks, location.assign, window.open, redirects the
     *     WebView reports. NOT called for POST form submissions or history (back/forward) navigations.
     *  2. shouldInterceptRequest, main frame only: sees every main-frame request, including POST and history
     *     loads, BEFORE it reaches the network, and answers a foreign one with an empty 403.
     *  3. onPageStarted / onPageFinished: if a foreign URL is nevertheless current, stop and load the app again.
     * Not covered: same-document changes (the URL hash), subframe and subresource requests (the bundled pages'
     * CSP has no frame-src and limits connect-src to self and https), and anything the WebView does not report.
     */
    private static class GuardedClient extends BridgeWebViewClient {
        GuardedClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !NavPolicy.allows(request.getUrl().toString()); // true = handled here = blocked
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !NavPolicy.allows(url); // pre-API-24 style callback, same rule
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (request.isForMainFrame() && !NavPolicy.allows(request.getUrl().toString())) {
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (!NavPolicy.allows(url)) {
                view.stopLoading();
                view.loadUrl(NavPolicy.START);
                return;
            }
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!NavPolicy.allows(url)) {
                view.stopLoading();
                view.loadUrl(NavPolicy.START);
                return;
            }
            super.onPageFinished(view, url);
        }
    }
}
