package net.arcflare.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Keeps the microphone working while an answered call from an agent is in progress (CallPlugin.begin), even when the
 * person switches to another app or the screen goes off. Android lets an app keep the microphone in the background only
 * from a foreground service that shows a notification. Not exported; started and stopped by CallPlugin only.
 */
public class CallService extends Service {

    private static final String CHANNEL = "arcflare-call-live";
    private static final int NOTE_ID = 1001; // outside NotifierPlugin's 0..999 and CallPlugin's ring (1000)

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Call in progress", NotificationManager.IMPORTANCE_LOW));
            }
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Call in progress")
            .setContentText("ArcFlare is using the microphone for a call from an agent")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(tap)
            .build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTE_ID, n);
        } catch (RuntimeException e) {
            // Android 14+ refuses a microphone service started while the app is not visible: the call goes on without it.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
