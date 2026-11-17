package net.arcflare.app;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.RemoteException;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;
import java.util.List;

/**
 * The recognition service Android requires of an assistant. While ArcFlare Agent is the assistant, apps that ask for the
 * phone's default speech recognizer may be sent here, so this passes every request on to the phone's own recognizer
 * (RecognizerPick) and passes its answers back. It records nothing itself. RecognitionService checks that the caller holds RECORD_AUDIO before
 * onStartListening runs, so no app can reach the microphone through this one without that permission.
 */
public class ArcRecognitionService extends RecognitionService {

    private SpeechRecognizer inner;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onStartListening(Intent request, Callback callback) {
        release();
        List<String> found = new ArrayList<>();
        for (ResolveInfo r : getPackageManager().queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0)) {
            if (r.serviceInfo != null) found.add(r.serviceInfo.packageName + "/" + r.serviceInfo.name);
        }
        String target = RecognizerPick.pick(found, getPackageName());
        if (target == null) { send(callback, SpeechRecognizer.ERROR_CLIENT); return; }
        inner = SpeechRecognizer.createSpeechRecognizer(this, ComponentName.unflattenFromString(target));
        inner.setRecognitionListener(new Forward(callback, inner));
        inner.startListening(request);
    }

    @Override
    protected void onStopListening(Callback callback) {
        if (inner != null) inner.stopListening();
    }

    @Override
    protected void onCancel(Callback callback) {
        release();
    }

    @Override
    public void onDestroy() {
        release();
        super.onDestroy();
    }

    private void release() {
        if (inner == null) return;
        inner.cancel();
        inner.destroy();
        inner = null;
    }

    private static void send(Callback cb, int error) {
        try { cb.error(error); } catch (RemoteException ignored) { /* the caller is gone */ }
    }

    /** After the final answer or an error, unbinds that recognizer, unless a newer request has replaced it already. */
    private void done(SpeechRecognizer which) {
        main.post(() -> { if (inner == which) release(); });
    }

    /** Passes the real recognizer's answers back to whoever asked us. A caller that has gone away is ignored. */
    private final class Forward implements RecognitionListener {
        private final Callback cb;
        private final SpeechRecognizer which;
        Forward(Callback cb, SpeechRecognizer which) { this.cb = cb; this.which = which; }

        @Override public void onReadyForSpeech(Bundle p) { try { cb.readyForSpeech(p); } catch (RemoteException ignored) { } }
        @Override public void onBeginningOfSpeech() { try { cb.beginningOfSpeech(); } catch (RemoteException ignored) { } }
        @Override public void onRmsChanged(float rms) { try { cb.rmsChanged(rms); } catch (RemoteException ignored) { } }
        @Override public void onBufferReceived(byte[] b) { try { cb.bufferReceived(b); } catch (RemoteException ignored) { } }
        @Override public void onEndOfSpeech() { try { cb.endOfSpeech(); } catch (RemoteException ignored) { } }
        @Override public void onError(int error) { send(cb, error); done(which); }
        @Override public void onResults(Bundle r) { try { cb.results(r); } catch (RemoteException ignored) { } done(which); }
        @Override public void onPartialResults(Bundle r) { try { cb.partialResults(r); } catch (RemoteException ignored) { } }
        @Override public void onEvent(int type, Bundle params) { }
    }
}
