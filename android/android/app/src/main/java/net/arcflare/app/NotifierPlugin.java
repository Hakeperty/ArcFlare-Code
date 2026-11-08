package net.arcflare.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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
 *   notify({ id, title, body }) -> posts or replaces notification `id` (0..999)
 */
@CapacitorPlugin(
    name = "Notifier",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class NotifierPlugin extends Plugin {

    private static final String CHANNEL = "arcflare";

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
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Agents and chats", NotificationManager.IMPORTANCE_DEFAULT));
            }
        }
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
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
