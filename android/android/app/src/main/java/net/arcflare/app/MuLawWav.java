package net.arcflare.app;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/**
 * A WAV file of 16 kHz mono G.711 mu-law: half the size of 16-bit PCM, still clear for speech, and every player reads
 * it. Pure Java (no Android classes) so test/mulaw.test.js compiles and runs it with javac.
 */
public final class MuLawWav {
    public static final int RATE = 16000;
    private static final int HEADER = 58; // RIFF, fmt (18 bytes, as WAVE wants for a non-PCM format), fact, data

    private final RandomAccessFile out;
    private long samples;

    public MuLawWav(File f) throws IOException {
        out = new RandomAccessFile(f, "rw");
        out.setLength(0);
        out.write(new byte[HEADER]);
    }

    public synchronized void write(short[] pcm, int n) throws IOException {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = encode(pcm[i]);
        out.write(b);
        samples += n;
    }

    /** Writes the sizes into the header and closes the file. */
    public synchronized void close() throws IOException {
        int data = (int) samples;
        out.seek(0);
        out.write(new byte[] { 'R', 'I', 'F', 'F' }); le32(HEADER - 8 + data);
        out.write(new byte[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' }); le32(18);
        le16(7); le16(1); le32(RATE); le32(RATE); le16(1); le16(8); le16(0); // mu-law, mono, 1 byte per sample
        out.write(new byte[] { 'f', 'a', 'c', 't' }); le32(4); le32(data);
        out.write(new byte[] { 'd', 'a', 't', 'a' }); le32(data);
        out.close();
    }

    /** ITU-T G.711 mu-law. */
    public static byte encode(short s) {
        int x = s;
        int sign = x < 0 ? 0x80 : 0;
        if (x < 0) x = -x;
        if (x > 32635) x = 32635;
        x += 0x84;
        int exp = 7;
        for (int mask = 0x4000; (x & mask) == 0 && exp > 0; exp--, mask >>= 1) { }
        int mant = (x >> (exp + 3)) & 0x0F;
        return (byte) ~(sign | (exp << 4) | mant);
    }

    private void le16(int v) throws IOException { out.write(v & 0xff); out.write((v >> 8) & 0xff); }
    private void le32(int v) throws IOException { le16(v & 0xffff); le16((v >>> 16) & 0xffff); }
}
