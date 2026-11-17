package net.arcflare.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;

/** A session per assist gesture. It shows nothing of its own: it opens the app with ACTION_ASSIST and closes. */
public class ArcVoiceSessionService extends VoiceInteractionSessionService {

    @Override
    public VoiceInteractionSession onNewSession(Bundle args) {
        return new Session(this);
    }

    static final class Session extends VoiceInteractionSession {
        Session(Context context) { super(context); }

        @Override
        public void onShow(Bundle args, int showFlags) {
            super.onShow(args, showFlags);
            // AssistPlugin sees ACTION_ASSIST and the page opens the Local AI chat.
            Intent open = new Intent(getContext(), MainActivity.class).setAction(Intent.ACTION_ASSIST);
            startAssistantActivity(open);
            hide();
        }
    }
}
