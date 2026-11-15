package net.arcflare.app;

import java.util.ArrayList;
import java.util.List;

/**
 * Paths the agent's file tools accept inside a picked folder. Pure Java (no Android classes), so
 * android/test/phonepath.test.js compiles and runs it.
 */
final class PhonePath {
    static final int MAX_LENGTH = 1024;
    static final int MAX_SEGMENTS = 32;
    static final int MAX_NAME = 255;

    private PhonePath() { }

    /** The folder and file names of a path relative to the picked folder; an empty array for the folder itself; null if refused. */
    static String[] split(String path) {
        if (path == null || path.equals("") || path.equals("/") || path.equals(".")) return new String[0];
        if (path.length() > MAX_LENGTH) return null;
        List<String> names = new ArrayList<>();
        for (String piece : path.split("/")) {
            if (piece.isEmpty()) continue;   // leading, trailing and doubled slashes
            if (!plainName(piece)) return null;
            names.add(piece);
        }
        if (names.size() > MAX_SEGMENTS) return null;
        return names.toArray(new String[0]);
    }

    private static boolean plainName(String name) {
        if (name.equals(".") || name.equals("..")) return false;
        if (name.length() > MAX_NAME) return false;
        if (!name.equals(name.trim())) return false;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c == '\\' || c < 0x20 || c == 0x7F) return false;
        }
        return true;
    }
}
