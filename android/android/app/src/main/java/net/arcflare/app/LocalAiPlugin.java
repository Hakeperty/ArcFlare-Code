package net.arcflare.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Local AI: a small chat model running on the phone itself (LlamaEngine, llama.cpp), with no computer and no internet
 * once the model is downloaded. Optional: nothing is downloaded or loaded until the person asks.
 *
 *   info()                               -> this phone's facts (chip, RAM, cores), the models and which are downloaded
 *   download({ id })                     -> fetches a ModelCatalog model; events "progress" { id, done, total }
 *   cancelDownload(), remove({ id })
 *   load({ id, threads, ctx })           -> loads a downloaded model (the page picks threads and ctx from the profile)
 *   chat({ messages, maxTokens })        -> answers; events "token" { text }; resolves { tokens, ms } or { error }
 *   stop(), unload()
 *
 * Models live in this app's private files (filesDir/models): no storage permission, removed with the app.
 */
@CapacitorPlugin(name = "LocalAI")
public class LocalAiPlugin extends Plugin {

    private final ExecutorService engine = Executors.newSingleThreadExecutor();
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancel = new AtomicBoolean();
    private volatile String loaded;   // id of the model in memory
    private volatile String downloading;   // id of the model being downloaded

    private File dir() {
        File d = new File(getContext().getFilesDir(), "models");
        if (!d.isDirectory() && !d.mkdirs()) d.mkdirs();
        return d;
    }

    // Capacitor turns an exception thrown by a plugin method into a crash of the whole app, and so does one thrown on
    // the two threads below. So info(), the download and all engine work answer the page with reject() instead.
    @PluginMethod
    public void info(PluginCall call) {
        try { call.resolve(facts()); }
        catch (Throwable t) { call.reject("could not read this phone's details: " + t); }
    }

    private JSObject facts() {
        JSObject r = new JSObject();
        r.put("available", LlamaEngine.AVAILABLE);
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("model", Build.MODEL);
        r.put("hardware", Build.HARDWARE);
        r.put("board", Build.BOARD);
        r.put("sdk", Build.VERSION.SDK_INT);
        if (Build.VERSION.SDK_INT >= 31) {
            r.put("socManufacturer", Build.SOC_MANUFACTURER);
            r.put("socModel", Build.SOC_MODEL);
        }
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        r.put("ramMb", mi.totalMem / (1024 * 1024));
        r.put("freeRamMb", mi.availMem / (1024 * 1024));
        r.put("cores", Runtime.getRuntime().availableProcessors());
        JSArray freqs = new JSArray();
        for (int i = 0; i < 16; i++) {
            File f = new File("/sys/devices/system/cpu/cpu" + i + "/cpufreq/cpuinfo_max_freq");
            if (!f.exists()) continue;
            try { freqs.put(Long.parseLong(new String(Files.readAllBytes(f.toPath()), StandardCharsets.US_ASCII).trim())); }
            catch (Exception ignored) { }
        }
        r.put("maxFreqsKHz", freqs);
        // Whether the connection is metered is not asked: that needs ACCESS_NETWORK_STATE, which this app does not hold,
        // and asking without it closed the app (1.0.457825). The notice says to use Wi-Fi instead.
        r.put("freeDiskMb", dir().getUsableSpace() / (1024 * 1024));
        r.put("loaded", loaded);
        JSArray models = new JSArray();
        for (ModelCatalog.Model m : ModelCatalog.MODELS) {
            JSObject o = new JSObject();
            o.put("id", m.id);
            o.put("name", m.name);
            o.put("size", m.size);
            o.put("license", m.license);
            o.put("minRamMb", m.minRamMb);
            File f = new File(dir(), m.file);
            o.put("downloaded", f.isFile() && f.length() == m.size);
            o.put("partial", new File(dir(), m.file + ".part").exists());   // a download that died half-way
            models.put(o);
        }
        r.put("models", models);
        return r;
    }

    @PluginMethod
    public void download(PluginCall call) {
        ModelCatalog.Model m = ModelCatalog.find(call.getString("id"));
        if (m == null) { call.reject("unknown model"); return; }
        if (dir().getUsableSpace() < m.size + 200L * 1024 * 1024) { call.reject("not enough free space on the phone"); return; }
        // One download at a time, so `downloading` and `cancel` always mean the same one. (Plugin calls arrive on one thread.)
        if (downloading != null) { call.reject("another model is downloading"); return; }
        cancel.set(false);
        downloading = m.id;
        downloads.execute(() -> {
            // A download killed with the app leaves its .part behind: clear every one before starting again.
            File[] left = dir().listFiles((d, name) -> name.endsWith(".part"));
            if (left != null) for (File x : left) x.delete();
            File part = new File(dir(), m.file + ".part"), done = new File(dir(), m.file);
            HttpURLConnection c = null;
            try {
                c = open(m.url);
                long len = c.getContentLengthLong();
                if (len != -1 && len != m.size) throw new IOException("the file is not the size its repo announced");
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                long got = 0, lastSent = 0;
                // shortcut: a broken download starts again from zero; resuming with Range needs the CDN's support checked.
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (cancel.get()) throw new IOException("cancelled");
                        if (got + n > m.size) throw new IOException("the download is larger than announced");
                        out.write(buf, 0, n);
                        sha.update(buf, 0, n);
                        got += n;
                        if (got - lastSent >= m.size / 100 || got == m.size) {
                            lastSent = got;
                            JSObject p = new JSObject();
                            p.put("id", m.id);
                            p.put("done", got);
                            p.put("total", m.size);
                            notifyListeners("progress", p);
                        }
                    }
                }
                if (got != m.size) throw new IOException("the download is incomplete");
                if (!hex(sha.digest()).equals(m.sha256)) throw new IOException("checksum mismatch: this is not the published file");
                if (cancel.get()) throw new IOException("cancelled");   // a Delete after the last chunk must still win
                if (!part.renameTo(done)) throw new IOException("could not save the model");
                call.resolve();
            } catch (Throwable e) {
                part.delete();
                call.reject("download failed: " + e.getMessage());
            } finally {
                downloading = null;
                if (c != null) c.disconnect();
            }
        });
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) { cancel.set(true); call.resolve(); }

    @PluginMethod
    public void remove(PluginCall call) {
        ModelCatalog.Model m = ModelCatalog.find(call.getString("id"));
        if (m == null) { call.reject("unknown model"); return; }
        if (m.id.equals(downloading)) cancel.set(true);   // the other screen may still be writing it
        onEngine(call, () -> {
            if (m.id.equals(loaded)) { LlamaEngine.nFree(); loaded = null; }
            new File(dir(), m.file).delete();
            new File(dir(), m.file + ".part").delete();
            call.resolve();
        });
    }

    @PluginMethod
    public void load(PluginCall call) {
        if (!LlamaEngine.AVAILABLE) { call.reject("Local AI needs a 64-bit ARM phone"); return; }
        ModelCatalog.Model m = ModelCatalog.find(call.getString("id"));
        if (m == null) { call.reject("unknown model"); return; }
        File f = new File(dir(), m.file);
        if (!f.isFile() || f.length() != m.size) { call.reject("download the model first"); return; }
        int threads = Math.max(1, Math.min(8, call.getInt("threads", 4)));
        int ctx = Math.max(512, Math.min(8192, call.getInt("ctx", 2048)));
        onEngine(call, () -> {
            LlamaEngine.start(getContext().getApplicationInfo().nativeLibraryDir);
            String err = LlamaEngine.nLoad(f.getAbsolutePath(), threads, ctx);
            if (err != null) { loaded = null; call.reject(err); return; }
            loaded = m.id;
            JSObject r = new JSObject();
            r.put("id", m.id);
            r.put("systemInfo", LlamaEngine.nSystemInfo());
            call.resolve(r);
        });
    }

    @PluginMethod
    public void chat(PluginCall call) {
        if (loaded == null) { call.reject("no model is loaded"); return; }
        JSArray msgs = call.getArray("messages");
        int maxTokens = Math.max(16, Math.min(2048, call.getInt("maxTokens", 512)));
        if (msgs == null || msgs.length() == 0) { call.reject("no messages"); return; }
        String[] roles = new String[msgs.length()], contents = new String[msgs.length()];
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject o = msgs.optJSONObject(i);
            String role = o == null ? "" : o.optString("role");
            if (!role.equals("system") && !role.equals("user") && !role.equals("assistant")) { call.reject("bad role"); return; }
            roles[i] = role;
            contents[i] = o.optString("content");
        }
        onEngine(call, () -> {
            long t0 = System.currentTimeMillis();
            String err = LlamaEngine.begin(roles, contents, maxTokens);
            JSObject r = new JSObject();
            if (err != null) { r.put("error", err); call.resolve(r); return; }
            int tokens = 0;
            StringBuilder batch = new StringBuilder();
            long sent = System.currentTimeMillis();
            String piece;
            while ((piece = LlamaEngine.next()) != null) {
                tokens++;
                batch.append(piece);
                if (System.currentTimeMillis() - sent >= 60 && batch.length() > 0) { emit(batch); sent = System.currentTimeMillis(); }
            }
            if (batch.length() > 0) emit(batch);
            if (LlamaEngine.nFailed()) { r.put("error", "the phone ran out of memory part-way through the answer"); call.resolve(r); return; }
            r.put("tokens", tokens);
            r.put("ms", System.currentTimeMillis() - t0);
            call.resolve(r);
        });
    }

    /** Engine work on its own thread. A failure there (a native method that is missing, no memory) is told to the page. */
    private void onEngine(PluginCall call, Runnable work) {
        engine.execute(() -> {
            try { work.run(); }
            catch (Throwable t) { call.reject("Local AI stopped: " + t); }
        });
    }

    private void emit(StringBuilder batch) {
        JSObject t = new JSObject();
        t.put("text", batch.toString());
        notifyListeners("token", t);
        batch.setLength(0);
    }

    @PluginMethod
    public void stop(PluginCall call) { stopEngine(); call.resolve(); }

    /** Asks a running answer to stop. Never throws: a phone without the engine has nothing to stop. */
    private static void stopEngine() {
        try { if (LlamaEngine.AVAILABLE) LlamaEngine.nStop(); } catch (Throwable t) { /* nothing is running */ }
    }

    @PluginMethod
    public void unload(PluginCall call) {
        if (!LlamaEngine.AVAILABLE) { call.resolve(); return; }
        stopEngine();
        onEngine(call, () -> { LlamaEngine.nFree(); loaded = null; call.resolve(); });
    }

    /** HTTPS to the model's repo, following its redirects only to Hugging Face hosts (ModelCatalog.allowedHost). */
    private static HttpURLConnection open(String url) throws IOException {
        for (int hop = 0; hop < 5; hop++) {
            if (!ModelCatalog.allowedHost(url)) throw new IOException("refused address");
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            if (code == 200) return c;
            String next = c.getHeaderField("Location");
            c.disconnect();
            if (code / 100 != 3 || next == null) throw new IOException("HTTP " + code);
            url = new URL(new URL(url), next).toString();
        }
        throw new IOException("too many redirects");
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    @Override
    protected void handleOnDestroy() {
        cancel.set(true);
        stopEngine();
        engine.execute(() -> { if (LlamaEngine.AVAILABLE) LlamaEngine.nFree(); });
        engine.shutdown();
        downloads.shutdown();
    }
}
