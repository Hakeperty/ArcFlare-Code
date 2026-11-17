package net.arcflare.app;

import android.service.voice.VoiceInteractionService;

/**
 * Makes ArcFlare Agent selectable as the phone's assistant (Settings, Default digital assistant app). Android binds it
 * only through BIND_VOICE_INTERACTION, a system permission (src/agent/AndroidManifest.xml). It does nothing itself: the
 * assist gesture starts a session (ArcVoiceSession), which opens the app.
 */
public class ArcVoiceService extends VoiceInteractionService { }
