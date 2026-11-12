package net.arcflare.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Local notifications for the app's own events (a chat answer is ready, an agent needs approval or finished),
 * shown while the app runs in the background. Nothing comes from a push service: no Firebase, no server key.
 * Text is shortened here as well as in JS; a tap opens the app (explicit, immutable intent), nothing else.
 *
 *   state()                     -> { granted }
 *   request()                   -> asks once (Android 13+ shows the system prompt), { granted }
 *   notify({ id, title, body, kind, sound })
 *                               -> posts or replaces notification `id` (0..999). kind (commit, push, done, failed, info)
 *                                  picks the channel and its sound (res/raw, made by scripts/make-sounds.js); sound
 *                                  false (muted on the computer, or outside the user's hours) uses a silent channel.
 *                                  Each channel's sound can be changed in Android's notification settings.
 */
@CapacitorPlugin(
    name = "Notifier",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class NotifierPlugin extends Plugin {

    private static final String CHANNEL = "arcflare";
    private static final String SILENT = "arcflare-silent";
    private static final String[][] KINDS = {
        // kind, channel, name shown in Android settings, sound in res/raw (null: the phone's default)
        { "commit", "arcflare-commit", "Commits", "af_commit" },
        { "push", "arcflare-push", "Pushes", "af_push" },
        { "done", "arcflare-done", "Finished", "af_done" },
        { "failed", "arcflare-failed", "Failed", "af_failed" },
    };

    /** The channel for this notice, made on first use. Android keeps a channel's sound once it exists. */
    private String channel(Context ctx, String kind, boolean sound) {
        String id = CHANNEL, name = "Agents and chats", raw = null;
        int importance = NotificationManager.IMPORTANCE_DEFAULT;
        if (!sound) { id = SILENT; name = "Silent (muted or outside your hours)"; importance = NotificationManager.IMPORTANCE_LOW; }
        else for (String[] k : KINDS) if (k[0].equals(kind)) { id = k[1]; name = k[2]; raw = k[3]; }
        if (Build.VERSION.SDK_INT < 26) return id;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(id) != null) return id;
        NotificationChannel ch = new NotificationChannel(id, name, importance);
        if (!sound) ch.setSound(null, null);
        else if (raw != null) {
            Uri uri = Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/" + raw);
            ch.setSound(uri, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        }
        nm.createNotificationChannel(ch);
        return id;
    }

    private boolean granted() {
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled()
            && (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", granted());
        call.resolve(r);
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            state(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "afterRequest");
    }

    @PermissionCallback
    private void afterRequest(PluginCall call) {
        state(call);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        if (!granted()) { call.reject("notifications are off"); return; }
        int id = call.getData().optInt("id", 0);
        if (id < 0 || id > 999) { call.reject("bad id"); return; }
        String title = clip(call.getString("title", "ArcFlare"), 80);
        String body = clip(call.getString("body", ""), 300);
        Context ctx = getContext();
        boolean sound = call.getBoolean("sound", true);
        String ch = channel(ctx, call.getString("kind", "info"), sound);
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, ch)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setSilent(!sound)
            // The text can contain project details: hide it on the lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build());
            call.resolve();
        } catch (SecurityException e) {
            call.reject("notifications are off");
        }
    }

    private static String clip(String s, int n) {
        if (s == null) return "";
        return s.length() > n ? s.substring(0, n - 1) + "…" : s;
    }
}
