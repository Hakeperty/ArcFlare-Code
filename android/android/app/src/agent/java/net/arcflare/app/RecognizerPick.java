package net.arcflare.app;

import java.util.List;

/**
 * Which speech recognizer ArcRecognitionService hands requests to. Pure Java, so a test runs it (recognizerpick.test.js).
 * Choosing an assistant makes Android use the assistant's recognition service for all voice input, so ours must pass
 * every request on to a real one: never itself, Google's first, then any other.
 */
final class RecognizerPick {
    private RecognizerPick() { }

    /** components: flattened component names ("pkg/class") of the installed recognition services. null when none fits. */
    static String pick(List<String> components, String ownPackage) {
        if (components == null) return null;
        String other = null;
        for (String c : components) {
            if (c == null) continue;
            int slash = c.indexOf('/');
            if (slash <= 0 || slash == c.length() - 1) continue;
            String pkg = c.substring(0, slash);
            if (pkg.equals(ownPackage)) continue;
            if (pkg.startsWith("com.google.android.")) return c;
            if (other == null) other = c;
        }
        return other;
    }
}
