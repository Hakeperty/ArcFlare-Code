package net.arcflare.app;

/**
 * Where the app looks for an update of itself when it is not signed in or cannot reach a computer, and what it
 * accepts from there. Pure Java (no Android classes), so android/test/onlineupdate.test.js compiles and runs it.
 *
 * The addresses are fixed here: the web layer cannot name another server or file. Two manifests, one per app:
 * android.json (ArcFlare, file ArcFlare-android-<version>.apk) and android-agent.json (ArcFlare Agent, file
 * ArcFlare-Agent-android-<version>.apk). Each has the same shape, e.g.
 *   { "versionCode": 450271, "versionName": "1.0.450271", "apk": "ArcFlare-android-1.0.450271.apk",
 *     "size": 3549285, "sha256": "<64 hex>" }
 * The APK is then read from arcflare.net/downloads/<apk>. Android still installs it only if it is signed with the
 * installed app's own key, and only after the person confirms.
 */
final class OnlineUpdate {
    static final String BASE = "https://arcflare.net/downloads/";
    static final long MAX_SIZE = 200L * 1024 * 1024;
    static final int MAX_MANIFEST = 16 * 1024;

    private OnlineUpdate() { }

    static String manifest(boolean agent) { return BASE + (agent ? "android-agent.json" : "android.json"); }

    /** null when the manifest's fields are acceptable, else what is wrong with them. */
    static String problem(long versionCode, String apk, long size, String sha256, boolean agent) {
        if (versionCode < 1 || versionCode > Integer.MAX_VALUE) return "bad versionCode";
        // A plain file name in /downloads/: no path, no query, no other host.
        String name = agent ? "^ArcFlare-Agent-android-[0-9][0-9.]{0,30}\\.apk$" : "^ArcFlare-android-[0-9][0-9.]{0,30}\\.apk$";
        if (apk == null || !apk.matches(name)) return "bad apk name";
        if (size < 1024 || size > MAX_SIZE) return "bad size";
        if (sha256 == null || !sha256.matches("^[0-9a-f]{64}$")) return "bad sha256";
        return null;
    }

    static String apkUrl(String apk) { return BASE + apk; }
}
