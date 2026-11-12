package net.arcflare.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Calls from agents on the computer (call_phone, lib/hub/calls.js). The hub's event reaches the app over the tunnel;
 * this plugin rings, speaks the agent's line, listens, and records.
 *
 * One microphone stream (AudioRecord, 16 kHz) feeds three things at the same time: the recording of the whole call
 * (conversation.wav), the recording of the current answer (answer-N.wav), and, on Android 13+, the speech recogniser
 * (EXTRA_AUDIO_SOURCE). Before Android 13 the recogniser needs the microphone itself, so nothing is recorded.
 * Recordings live in the app's cache until the page has uploaded them to the computer, then clear() deletes them.
 *
 *   ringtone()                 -> { title }                   pickRingtone() -> { title }   (Android's ringtone picker)
 *   ring({ title, seconds })   rings with the chosen ringtone and shows a call notification; stopRing()
 *   start()                    asks for the microphone, starts recording -> { recording }
 *   speak({ text })            resolves when the line has been said
 *   listen({ seconds })        -> { text } ("" when nothing was understood)
 *   stop()                     -> { files: [{ name, size }] }
 *   read({ name, offset, length }) -> { data (base64) }      clear()
 */
@CapacitorPlugin(
    name = "Call",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class CallPlugin extends Plugin {

    private static final String PREFS = "arcflare-call";
    private static final String CHANNEL = "arcflare-calls";
    private static final int NOTE_ID = 1000; // outside NotifierPlugin's 0..999
    private static final int MAX_READ = 48 * 1024;

    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ttsReady;
    private final Map<String, PluginCall> speaking = new HashMap<>();
    private Ringtone ringing;
    private final Runnable ringStop = this::stopRinging;

    private AudioRecord rec;
    private Thread loop;
    private volatile boolean running;
    private volatile MuLawWav convo;
    private volatile MuLawWav answer;
    private volatile OutputStream pipe;
    // Added on the main thread (listen), read on the plugin thread (stop): a copy-on-write list is safe for both.
    private final List<String> files = new CopyOnWriteArrayList<>();
    private int answers;
    private SpeechRecognizer recognizer;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), (status) -> ttsReady = status == TextToSpeech.SUCCESS);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { finishSpeaking(id, null); }
            @Override public void onError(String id) { finishSpeaking(id, "the phone could not say the line"); }
        });
    }

    @Override
    protected void handleOnDestroy() {
        stopRinging();
        stopRecording();
        if (tts != null) tts.shutdown();
    }

    private File dir() {
        File d = new File(getContext().getCacheDir(), "calls");
        d.mkdirs();
        return d;
    }

    // ---- ringtone ----

    private Uri ringtoneUri() {
        String s = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("ringtone", null);
        return s != null ? Uri.parse(s) : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    }

    private String title(Uri uri) {
        Ringtone r = uri == null ? null : RingtoneManager.getRingtone(getContext(), uri);
        return r != null ? r.getTitle(getContext()) : "Silent";
    }

    @PluginMethod
    public void ringtone(PluginCall call) {
        JSObject r = new JSObject();
        r.put("title", title(ringtoneUri()));
        call.resolve(r);
    }

    @PluginMethod
    public void pickRingtone(PluginCall call) {
        Intent i = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_RINGTONE)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Ringtone for calls from agents")
            .putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, ringtoneUri());
        startActivityForResult(call, i, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Uri uri = result.getData().getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
            if (uri != null) getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("ringtone", uri.toString()).apply();
        }
        ringtone(call);
    }

    @PluginMethod
    public void ring(PluginCall call) {
        Context ctx = getContext();
        int seconds = Math.max(1, Math.min(60, call.getInt("seconds", 45)));
        String who = clip(call.getString("title", "Your computer is calling"), 80);
        main.post(() -> {
            stopRinging();
            ringing = RingtoneManager.getRingtone(ctx, ringtoneUri());
            if (ringing != null) {
                ringing.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                if (Build.VERSION.SDK_INT >= 28) ringing.setLooping(true);
                ringing.play();
            }
            main.postDelayed(ringStop, seconds * 1000L);
        });
        // The notification is how a call reaches someone with the app in the background: a tap opens it.
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Calls from agents", NotificationManager.IMPORTANCE_HIGH);
                ch.setSound(null, null); // the ringtone above is the sound
                nm.createNotificationChannel(ch);
            }
        }
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(who)
            .setContentText("Tap to answer in ArcFlare")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setTimeoutAfter(seconds * 1000L)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try { NotificationManagerCompat.from(ctx).notify(NOTE_ID, b.build()); } catch (SecurityException e) { /* notifications off: it still rings */ }
        call.resolve();
    }

    @PluginMethod
    public void stopRing(PluginCall call) {
        main.post(this::stopRinging);
        call.resolve();
    }

    private void stopRinging() {
        main.removeCallbacks(ringStop);
        if (ringing != null) { ringing.stop(); ringing = null; }
        NotificationManagerCompat.from(getContext()).cancel(NOTE_ID);
    }

    // ---- the call ----

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { requestPermissionForAlias("microphone", call, "afterMic"); return; }
        begin(call);
    }

    @PermissionCallback
    private void afterMic(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("The microphone is off for ArcFlare. Allow it in Android's settings to take calls."); return; }
        begin(call);
    }

    private void begin(PluginCall call) {
        stopRecording();
        clearFiles();
        files.clear();
        answers = 0;
        boolean recording = false;
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                int min = AudioRecord.getMinBufferSize(MuLawWav.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, MuLawWav.RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(min, MuLawWav.RATE));
                convo = new MuLawWav(new File(dir(), "conversation.wav"));
                files.add("conversation.wav");
                rec.startRecording();
                running = true;
                loop = new Thread(this::pump, "arcflare-call-audio");
                loop.start();
                recording = true;
            } catch (Exception e) {
                stopRecording();
            }
        }
        JSObject r = new JSObject();
        r.put("recording", recording);
        call.resolve(r);
    }

    /** The one microphone stream, copied to every listener. */
    private void pump() {
        short[] buf = new short[MuLawWav.RATE / 10];
        byte[] le = new byte[buf.length * 2];
        while (running) {
            int n = rec.read(buf, 0, buf.length);
            if (n <= 0) continue;
            MuLawWav c = convo;
            if (c == null) break;
            try { c.write(buf, n); } catch (IOException e) { running = false; }
            MuLawWav a = answer;
            if (a != null) try { a.write(buf, n); } catch (IOException e) { answer = null; }
            OutputStream p = pipe;
            if (p != null) {
                for (int i = 0; i < n; i++) { le[2 * i] = (byte) buf[i]; le[2 * i + 1] = (byte) (buf[i] >> 8); }
                try { p.write(le, 0, n * 2); } catch (IOException e) { pipe = null; }
            }
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = clip(call.getString("text", ""), 1000);
        if (!ttsReady) { call.reject("This phone has no text-to-speech voice. Install one in Android's settings."); return; }
        String id = "say-" + System.nanoTime();
        call.setKeepAlive(true);
        synchronized (speaking) { speaking.put(id, call); }
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) finishSpeaking(id, "the phone could not say the line");
    }

    private void finishSpeaking(String id, String error) {
        PluginCall c;
        synchronized (speaking) { c = speaking.remove(id); }
        if (c == null) return;
        c.setKeepAlive(false);
        if (error != null) c.reject(error); else c.resolve();
    }

    @PluginMethod
    public void listen(PluginCall call) {
        int seconds = Math.max(3, Math.min(60, call.getInt("seconds", 30)));
        call.setKeepAlive(true);
        main.post(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) { call.setKeepAlive(false); call.reject("This phone has no speech recognition. Type the answer instead."); return; }
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500);
            if (running && Build.VERSION.SDK_INT >= 33) {
                try {
                    ParcelFileDescriptor[] p = ParcelFileDescriptor.createPipe();
                    String name = "answer-" + (++answers) + ".wav";
                    answer = new MuLawWav(new File(dir(), name));
                    files.add(name);
                    pipe = new ParcelFileDescriptor.AutoCloseOutputStream(p[1]);
                    i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, p[0])
                        .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                        .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                        .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, MuLawWav.RATE);
                } catch (IOException e) { endAnswer(); }
            }
            if (recognizer != null) recognizer.destroy();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            final boolean[] done = { false };
            Runnable timeUp = () -> { if (recognizer != null) recognizer.stopListening(); };
            main.postDelayed(timeUp, seconds * 1000L);
            recognizer.setRecognitionListener(new RecognitionListener() {
                private void finish(String text, String error) {
                    if (done[0]) return;
                    done[0] = true;
                    main.removeCallbacks(timeUp);
                    endAnswer();
                    call.setKeepAlive(false);
                    if (error != null) { call.reject(error); return; }
                    JSObject r = new JSObject();
                    r.put("text", text);
                    call.resolve(r);
                }
                @Override public void onResults(Bundle b) {
                    ArrayList<String> m = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    finish(m != null && !m.isEmpty() ? m.get(0) : "", null);
                }
                @Override public void onError(int code) {
                    if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) finish("", null);
                    else finish(null, "Speech recognition failed (" + code + "). Type the answer instead.");
                }
                @Override public void onEndOfSpeech() { closePipe(); }
                @Override public void onReadyForSpeech(Bundle b) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float v) { }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onPartialResults(Bundle b) { }
                @Override public void onEvent(int t, Bundle b) { }
            });
            recognizer.startListening(i);
        });
    }

    private void closePipe() {
        OutputStream p = pipe;
        pipe = null;
        if (p != null) try { p.close(); } catch (IOException e) { /* the recogniser already went */ }
    }

    private void endAnswer() {
        closePipe();
        MuLawWav a = answer;
        answer = null;
        if (a != null) try { a.close(); } catch (IOException e) { /* a short file is still a file */ }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // The recogniser lives on the main thread; the recording is stopped here, off it (it waits for the audio thread).
        main.post(() -> { if (recognizer != null) { recognizer.destroy(); recognizer = null; } });
        if (tts != null) tts.stop();
        stopRecording();
        JSArray list = new JSArray();
        for (String name : files) {
            File f = new File(dir(), name);
            if (!f.isFile()) continue;
            JSObject o = new JSObject();
            o.put("name", name);
            o.put("size", f.length());
            list.put(o);
        }
        JSObject r = new JSObject();
        r.put("files", list);
        call.resolve(r);
    }

    private void stopRecording() {
        running = false;
        endAnswer();
        if (loop != null) { try { loop.join(2000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } loop = null; }
        if (rec != null) { try { rec.stop(); } catch (IllegalStateException e) { /* never started */ } rec.release(); rec = null; }
        if (convo != null) { try { convo.close(); } catch (IOException e) { /* keep what was written */ } convo = null; }
    }

    @PluginMethod
    public void read(PluginCall call) {
        String name = call.getString("name", "");
        if (!name.matches("^(conversation|answer-\\d{1,2})\\.wav$")) { call.reject("bad name"); return; }
        long offset = call.getData().optLong("offset", 0);
        int length = Math.max(1, Math.min(MAX_READ, call.getInt("length", MAX_READ)));
        try (RandomAccessFile f = new RandomAccessFile(new File(dir(), name), "r")) {
            if (offset < 0 || offset > f.length()) { call.reject("bad offset"); return; }
            byte[] b = new byte[(int) Math.min(length, f.length() - offset)];
            f.seek(offset);
            f.readFully(b);
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(b, Base64.NO_WRAP));
            call.resolve(r);
        } catch (IOException e) {
            call.reject("could not read the recording");
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        clearFiles();
        call.resolve();
    }

    private void clearFiles() {
        File[] list = dir().listFiles();
        if (list != null) for (File f : list) f.delete();
    }

    private static String clip(String s, int n) {
        if (s == null) return "";
        return s.length() > n ? s.substring(0, n - 1) + "…" : s;
    }
}
