package net.arcflare.app;

import com.getcapacitor.BridgeActivity;

/** Which of the two apps this is. This one: ArcFlare, the chat build (net.arcflare.app). See app/build.gradle. */
final class Edition {
    static final boolean AGENT = false;

    private Edition() { }

    /** Registers the plugins only this build has: none. */
    static void register(BridgeActivity activity) { }
}
