package net.arcflare.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.ResolveInfo;

import androidx.core.content.ContextCompat;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;
import java.security.MessageDigest;

/**
 * Installs an update of this app, handed over in chunks by the web layer (which downloads it from the
 * signed-in hub). Nothing is written to shared storage and no file is shared with another app: the bytes go straight
 * into a PackageInstaller session. Before committing, the size and SHA-256 must equal what the hub's
 * /api/app/version announced; Android then refuses the update unless it is signed with this app's own key,
 * and always asks the user to confirm.
 *
 *   info()                         -> { versionCode, versionName, canInstall }
 *   begin({ size, sha256 })        -> starts a session (any previous one is abandoned)
 *   write({ data })                -> base64 chunk, in order
 *   commit()                       -> verifies, commits; resolves { status } once Android has answered
 *   abort()                        -> abandons the session
 *   openInstallSettings()          -> the "install unknown apps" switch for this app
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final long MAX_SIZE = 200L * 1024 * 1024;
    private static final String ACTION = "net.arcflare.app.UPDATE_STATUS";

    private PackageInstaller.Session session;
    private int sessionId = -1;
    private OutputStream out;
    private MessageDigest digest;
    private long expectedSize;
    private String expectedSha;
    private long written;
    private PluginCall pendingCommit;
    private BroadcastReceiver receiver;

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            r.put("versionCode", code);
            r.put("versionName", pi.versionName);
        } catch (PackageManager.NameNotFoundException e) {
            call.reject("cannot read this app's version");
            return;
        }
        r.put("canInstall", getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public synchronized void begin(PluginCall call) {
        abandon();
        Long size = call.getLong("size");
        String sha = call.getString("sha256");
        if (size == null || size < 1024 || size > MAX_SIZE) { call.reject("bad size"); return; }
        if (sha == null || !sha.matches("^[0-9a-f]{64}$")) { call.reject("bad sha256"); return; }
        try {
            PackageInstaller pi = getContext().getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(getContext().getPackageName()); // only ever an update of this app
            p.setSize(size);
            sessionId = pi.createSession(p);
            session = pi.openSession(sessionId);
            out = session.openWrite("base.apk", 0, size);
            digest = MessageDigest.getInstance("SHA-256");
            expectedSize = size;
            expectedSha = sha;
            written = 0;
            call.resolve();
        } catch (Exception e) {
            abandon();
            call.reject("could not start the install: " + e.getMessage());
        }
    }

    @PluginMethod
    public synchronized void write(PluginCall call) {
        if (out == null) { call.reject("no install in progress"); return; }
        String data = call.getString("data");
        if (data == null) { call.reject("no data"); return; }
        byte[] b;
        try { b = Base64.decode(data, Base64.DEFAULT); } catch (IllegalArgumentException e) { abandon(); call.reject("bad chunk"); return; }
        if (written + b.length > expectedSize) { abandon(); call.reject("the download is larger than announced"); return; }
        try {
            out.write(b);
            digest.update(b);
            written += b.length;
            JSObject r = new JSObject();
            r.put("written", written);
            call.resolve(r);
        } catch (IOException e) {
            abandon();
            call.reject("write failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public synchronized void commit(PluginCall call) {
        if (out == null || session == null) { call.reject("no install in progress"); return; }
        try {
            if (written != expectedSize) { abandon(); call.reject("the download is incomplete"); return; }
            String got = hex(digest.digest());
            if (!got.equals(expectedSha)) { abandon(); call.reject("checksum mismatch: the download is not the announced update"); return; }
            session.fsync(out);
            out.close();
            out = null;
            listen();
            Intent i = new Intent(ACTION).setPackage(getContext().getPackageName()); // explicit: only this app receives it
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pi = PendingIntent.getBroadcast(getContext(), sessionId, i, flags);
            pendingCommit = call;
            call.setKeepAlive(true);
            session.commit(pi.getIntentSender());
            session.close();
            session = null;
        } catch (Exception e) {
            abandon();
            call.reject("install failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public synchronized void abort(PluginCall call) {
        abandon();
        call.resolve();
    }

    private void listen() {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (pendingCommit == null) return; // nothing of ours is being installed: ignore
                int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    // Launch it only if it opens a system app (the package installer's confirmation screen):
                    // never an arbitrary intent handed to us.
                    if (confirm != null && opensSystemApp(ctx, confirm)) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        ctx.startActivity(confirm);
                    }
                    return;
                }
                PluginCall c = pendingCommit;
                pendingCommit = null;
                if (c == null) return;
                JSObject r = new JSObject();
                r.put("status", status == PackageInstaller.STATUS_SUCCESS ? "installed" : "failed");
                r.put("message", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
                c.resolve(r);
                c.release(getBridge());
            }
        };
        // Not exported on every Android version: below 13, ContextCompat guards it with this app's own
        // DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION, so no other app can send it a status or an intent.
        ContextCompat.registerReceiver(getContext(), receiver, new IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private static boolean opensSystemApp(Context ctx, Intent i) {
        ResolveInfo ri = ctx.getPackageManager().resolveActivity(i, 0);
        if (ri == null || ri.activityInfo == null || ri.activityInfo.applicationInfo == null) return false;
        return (ri.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
    }

    private void abandon() {
        try { if (out != null) out.close(); } catch (IOException ignored) { }
        out = null;
        if (session != null) { try { session.abandon(); } catch (Exception ignored) { } session = null; }
        sessionId = -1;
        digest = null;
        written = 0;
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    @Override
    protected void handleOnDestroy() {
        abandon();
        if (receiver != null) { try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) { } receiver = null; }
    }
}
