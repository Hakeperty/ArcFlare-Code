package net.arcflare.app;

import java.nio.charset.StandardCharsets;

/** The native chat engine (src/main/cpp/arcflare_llm.cpp, llama.cpp). Absent on phones that are not arm64. */
final class LlamaEngine {
    static final boolean AVAILABLE;
    static {
        boolean ok;
        try { System.loadLibrary("arcflare_llm"); ok = true; } catch (Throwable t) { ok = false; }
        AVAILABLE = ok;
    }

    private static boolean started;

    private LlamaEngine() { }

    static synchronized void start(String nativeLibDir) {
        if (started) return;
        nInit(nativeLibDir);
        started = true;
    }

    static String begin(String[] roles, String[] contents, int maxTokens) {
        byte[][] b = new byte[contents.length][];
        for (int i = 0; i < contents.length; i++) b[i] = contents[i].getBytes(StandardCharsets.UTF_8);
        return nBegin(roles, b, maxTokens);
    }

    /** The next piece of the answer, "" while a character is incomplete, null at the end. */
    static String next() {
        byte[] b = nNext();
        return b == null ? null : new String(b, StandardCharsets.UTF_8);
    }

    static native void nInit(String nativeLibDir);
    static native String nSystemInfo();
    static native String nLoad(String path, int threads, int nCtx);
    static native String nBegin(String[] roles, byte[][] contents, int maxTokens);
    static native byte[] nNext();
    static native void nStop();
    static native void nFree();
}
