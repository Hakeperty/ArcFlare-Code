package net.arcflare.app;

/**
 * The chat models the phone may download for Local AI, and where from. Pure Java (no Android classes), so
 * android/test/modelcatalog.test.js compiles and runs it.
 *
 * Fixed here, not passed in by the page: each file comes from its maker's own Hugging Face repo at a pinned commit, and
 * must have exactly this size and SHA-256 (read from the repo on 2026-11-14). ArcFlare never hosts or mirrors weights.
 * Licences: both Qwen3 repos carry Apache-2.0 (their LICENSE files, read 2026-11-14), as on arcflare.net/licenses.
 */
final class ModelCatalog {
    static final class Model {
        final String id, name, file, url, sha256, license;
        final long size;
        final int minRamMb;   // below this much RAM the phone is not offered the model

        Model(String id, String name, String file, String url, long size, String sha256, String license, int minRamMb) {
            this.id = id; this.name = name; this.file = file; this.url = url; this.size = size; this.sha256 = sha256;
            this.license = license; this.minRamMb = minRamMb;
        }
    }

    static final Model[] MODELS = {
        new Model("qwen3-0.6b", "Qwen3 0.6B", "Qwen3-0.6B-Q8_0.gguf",
            "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf",
            639446688L, "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031", "Apache-2.0", 3000),
        new Model("qwen3-1.7b", "Qwen3 1.7B", "Qwen3-1.7B-Q8_0.gguf",
            "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf",
            1834426016L, "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a", "Apache-2.0", 7000),
    };

    private ModelCatalog() { }

    static Model find(String id) {
        if (id == null) return null;
        for (Model m : MODELS) if (m.id.equals(id)) return m;
        return null;
    }

    /**
     * May a download go to this address? Hugging Face answers the pinned URL with a redirect to its own CDN, so only
     * https on huggingface.co or a *.hf.co host is followed; anything else is refused.
     */
    static boolean allowedHost(String url) {
        if (url == null || !url.startsWith("https://")) return false;
        int end = url.length();
        for (char c : new char[] { '/', '?', '#' }) { int i = url.indexOf(c, 8); if (i != -1 && i < end) end = i; }
        String host = url.substring(8, end).toLowerCase(java.util.Locale.ROOT);
        if (host.isEmpty() || host.contains("@") || host.contains(":") || host.contains("\\")) return false;
        return host.equals("huggingface.co") || (host.endsWith(".hf.co") && host.length() > ".hf.co".length());
    }
}
