package net.arcflare.app;

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

    private NavPolicy() {}

    /** True only for the bundled origin. Null and everything else (http, other hosts, ports, user info, data:, javascript:, blob:, file:, about:) is false. */
    static boolean allows(String url) {
        return url != null && BUNDLED.matcher(url).matches();
    }
}
