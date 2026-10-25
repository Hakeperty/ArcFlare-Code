package net.arcflare.app;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The one navigation rule of this app: the WebView may show the bundled app (https://localhost) and NOTHING else.
 * There is no setter, no stored exception, no plugin: the hub's own plain-http page is never loaded (the app talks
 * to the hub through the encrypted tunnel from the bundled UI).
 *
 * Pure Java on purpose (no Android classes), so android/test/navpolicy.test.js can compile and run it with javac.
 *
 * It judges the raw URL string with an exact pattern instead of parsing it with android.net.Uri: Chromium and
 * Uri disagree about backslashes and whitespace ("https://evil.example\@localhost/" has host localhost for Uri and
 * host evil.example for Chromium), so anything but the literal origin "https://localhost" followed by nothing or
 * by a path/query/fragment without backslash, whitespace or control characters is refused.
 */
final class NavPolicy {
    /** The page the WebView is sent back to when something slips through. */
    static final String START = "https://localhost/";

    // https://localhost  then optionally  / ? #  and anything except backslash, whitespace, control characters.
    private static final Pattern BUNDLED = Pattern.compile(
        "https://localhost(?:[/?#][^\\\\\\x00-\\x20\\x7f]*)?",
        Pattern.CASE_INSENSITIVE);

    // Capacitor's local server answers this path by fetching the URL in its query with the native stack (and the
    // native cookie jar) on behalf of the page. The WebView must never be sent there, however the path is spelled
    // (dot segments, upper case, %5F for the underscore): refused anywhere in the URL, not only as a prefix.
    private static final String INTERCEPTOR = "_capacitor_http_interceptor_";
    private static final String INTERCEPTOR_HTTPS = "_capacitor_https_interceptor_";

    private NavPolicy() {}

    /** True only for the bundled origin. Null and everything else (http, other hosts, ports, user info, data:, javascript:, blob:, file:, about:) is false. */
    static boolean allows(String url) {
        if (url == null || !BUNDLED.matcher(url).matches()) return false;
        // Compare against the fully percent-decoded form: Capacitor matches the DECODED path, so %63, %5F, %255F
        // and friends must not hide the interceptor path. The https variant of the path is refused as well.
        String low = decode(url).toLowerCase(Locale.ROOT);
        return !low.contains(INTERCEPTOR) && !low.contains(INTERCEPTOR_HTTPS);
    }

    /** Percent-decode until nothing changes (at most 5 passes: %2563 is %63 is c). Malformed escapes stay as they are. */
    static String decode(String s) {
        for (int pass = 0; pass < 5; pass++) {
            StringBuilder sb = new StringBuilder(s.length());
            boolean changed = false;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c == '%' && i + 2 < s.length()) {
                    int hi = Character.digit(s.charAt(i + 1), 16), lo = Character.digit(s.charAt(i + 2), 16);
                    if (hi >= 0 && lo >= 0) { sb.append((char) (hi * 16 + lo)); i += 2; changed = true; continue; }
                }
                sb.append(c);
            }
            s = sb.toString();
            if (!changed) break;
        }
        return s;
    }
}
