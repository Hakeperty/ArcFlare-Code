package net.arcflare.app;

import com.getcapacitor.BridgeActivity;

/** Which of the two apps this is. This one: ArcFlare Agent, the agent build (net.arcflare.app.agent). See app/build.gradle. */
final class Edition {
    static final boolean AGENT = true;

    private Edition() { }

    /** Registers the plugins only this build has. */
    static void register(BridgeActivity activity) {
        // Files in folders the person picked (see PhoneFilesPlugin).
        activity.registerPlugin(PhoneFilesPlugin.class);
    }
}
