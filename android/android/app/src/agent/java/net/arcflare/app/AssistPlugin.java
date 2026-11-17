package net.arcflare.app;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the page the person opened the app with the phone's assistant gesture (agent build only). Android sends
 * ACTION_ASSIST to the app set as the default digital assistant (power button hold, corner swipe, "Hey Google" slot).
 *
 *   consume()   -> { assist: true } once if the app was started by the gesture, else { assist: false }
 *   event "assist": the app was already running and the gesture opened it again
 */
@CapacitorPlugin(name = "Assist")
public class AssistPlugin extends Plugin {

    private boolean pending;

    @Override
    public void load() {
        pending = isAssist(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (!isAssist(intent)) return;
        pending = true;
        notifyListeners("assist", new JSObject(), true); // retained: the page may start listening a moment later
    }

    @PluginMethod
    public void consume(PluginCall call) {
        JSObject r = new JSObject();
        r.put("assist", pending);
        pending = false;
        call.resolve(r);
    }

    private static boolean isAssist(Intent intent) {
        return intent != null && Intent.ACTION_ASSIST.equals(intent.getAction());
    }
}
