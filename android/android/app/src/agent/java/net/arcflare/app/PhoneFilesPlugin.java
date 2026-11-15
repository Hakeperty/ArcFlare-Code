package net.arcflare.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Files for the on-phone agent (agent build only): list, read and write text files. Only folders the person picked
 * with Android's folder picker; no storage permission.
 *
 *   folders()                      -> { folders: [{ id, name }] }
 *   pickFolder()                   -> { id, name }, or { cancelled: true }
 *   forget({ id })                 -> releases a folder
 *   list({ id, path })             -> { entries: [{ name, dir, size }], truncated }
 *   read({ id, path })             -> { text, bytes, truncated }
 *   write({ id, path, content })   -> { created, name, bytes }
 *
 * Paths are relative to the picked folder and split on "/" (PhonePath.java). Android confines the app to the picked
 * folders; this class also refuses any path that is not a plain name inside them.
 */
@CapacitorPlugin(name = "PhoneFiles")
public class PhoneFilesPlugin extends Plugin {

    private static final int MAX_ENTRIES = 200;
    private static final int MAX_READ = 64 * 1024;     // bytes
    private static final int MAX_WRITE = 256 * 1024;   // bytes of UTF-8

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /** A document found by walking names down from the picked folder. */
    private static final class Found { String doc; String mime; }

    @Override
    protected void handleOnDestroy() { io.shutdownNow(); }

    /** The picked folder with this id, or null: only folders Android still lists as granted to this app. */
    private Uri tree(String id) {
        if (id == null) return null;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.isReadPermission() && p.isWritePermission() && p.getUri().toString().equals(id)) return p.getUri();
        }
        return null;
    }

    /** The document at `names` under the tree, or null. Each step lists the folder and matches the name exactly. */
    private Found find(Uri tree, String[] names) {
        ContentResolver cr = getContext().getContentResolver();
        Found f = new Found();
        f.doc = DocumentsContract.getTreeDocumentId(tree);
        f.mime = Document.MIME_TYPE_DIR;
        for (String name : names) {
            if (!Document.MIME_TYPE_DIR.equals(f.mime)) return null;
            String next = null, mime = null;
            try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, f.doc),
                    new String[] { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE }, null, null, null)) {
                while (c != null && c.moveToNext()) {
                    if (name.equals(c.getString(1))) { next = c.getString(0); mime = c.getString(2); break; }
                }
            }
            if (next == null) return null;
            f.doc = next;
            f.mime = mime;
        }
        return f;
    }

    /** The display name of a document, or the last path segment of its uri when the provider gives none. */
    private String name(Uri tree, String doc) {
        Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, doc);
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (RuntimeException e) {
            // A folder whose storage is gone (a removed card) must still be listed, so it can be un-shared.
        }
        return uri.getLastPathSegment();
    }

    /** { id, name } for one picked folder. */
    private JSObject summary(Uri tree) {
        JSObject o = new JSObject();
        o.put("id", tree.toString());
        o.put("name", name(tree, DocumentsContract.getTreeDocumentId(tree)));
        return o;
    }

    /**
     * The MIME type for a new file. A MIME type that does not match the name's extension makes the storage provider
     * append another one (notes.md would become notes.md.txt), so the type is taken from the name.
     */
    private static String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        String mime = ext.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime != null ? mime : "application/octet-stream";
    }

    @PluginMethod
    public void folders(PluginCall call) {
        io.execute(() -> {
            try {
                JSArray arr = new JSArray();
                for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
                    if (p.isReadPermission() && p.isWritePermission()) arr.put(summary(p.getUri()));
                }
                JSObject r = new JSObject();
                r.put("folders", arr);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("could not list the folders: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (uri == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        io.execute(() -> {
            try {
                try {
                    getContext().getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (SecurityException e) {
                    call.reject("Android did not grant that folder");
                    return;
                }
                call.resolve(summary(uri));
            } catch (Exception e) {
                call.reject("could not read the folder: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String id = call.getString("id");
        io.execute(() -> {
            try {
                Uri uri = tree(id);
                if (uri != null) {
                    getContext().getContentResolver().releasePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("could not forget the folder: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        String id = call.getString("id");
        String path = call.getString("path");
        io.execute(() -> {
            try {
                Uri tree = tree(id);
                if (tree == null) { call.reject("that folder is not shared with ArcFlare Agent"); return; }
                String[] names = PhonePath.split(path);
                if (names == null) { call.reject("bad path"); return; }
                Found dir = find(tree, names);
                if (dir == null || !Document.MIME_TYPE_DIR.equals(dir.mime)) { call.reject("no such folder"); return; }
                JSArray entries = new JSArray();
                boolean truncated = false;
                try (Cursor c = getContext().getContentResolver().query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir.doc),
                        new String[] { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE },
                        null, null, null)) {
                    while (c != null && c.moveToNext()) {
                        if (entries.length() >= MAX_ENTRIES) { truncated = true; break; }
                        boolean isDir = Document.MIME_TYPE_DIR.equals(c.getString(2));
                        JSObject o = new JSObject();
                        o.put("name", c.getString(1));
                        o.put("dir", isDir);
                        o.put("size", (isDir || c.isNull(3)) ? 0L : c.getLong(3));
                        entries.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("entries", entries);
                r.put("truncated", truncated);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("could not list the folder: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void read(PluginCall call) {
        String id = call.getString("id");
        String path = call.getString("path");
        io.execute(() -> {
            try {
                Uri tree = tree(id);
                if (tree == null) { call.reject("that folder is not shared with ArcFlare Agent"); return; }
                String[] names = PhonePath.split(path);
                if (names == null) { call.reject("bad path"); return; }
                Found f = find(tree, names);
                if (f == null || Document.MIME_TYPE_DIR.equals(f.mime)) { call.reject("no such file"); return; }
                byte[] buf = new byte[MAX_READ];
                int n = 0;
                boolean truncated;
                try (InputStream in = getContext().getContentResolver().openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, f.doc))) {
                    if (in == null) { call.reject("could not open the file"); return; }
                    int got;
                    while (n < MAX_READ && (got = in.read(buf, n, MAX_READ - n)) != -1) n += got;
                    truncated = n == MAX_READ && in.read() != -1;
                }
                for (int i = 0; i < n; i++) {
                    if (buf[i] == 0) { call.reject("not a text file"); return; }
                }
                String text = new String(buf, 0, n, StandardCharsets.UTF_8);
                // A cut that splits a UTF-8 character leaves one replacement character at the end: drop it.
                if (truncated && text.endsWith("\uFFFD")) text = text.substring(0, text.length() - 1);
                JSObject r = new JSObject();
                r.put("text", text);
                r.put("bytes", n);
                r.put("truncated", truncated);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("could not read the file: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        String id = call.getString("id");
        String path = call.getString("path");
        String content = call.getString("content");
        io.execute(() -> {
            try {
                Uri tree = tree(id);
                if (tree == null) { call.reject("that folder is not shared with ArcFlare Agent"); return; }
                if (content == null) { call.reject("nothing to write"); return; }
                byte[] data = content.getBytes(StandardCharsets.UTF_8);
                if (data.length > MAX_WRITE) { call.reject("too large: at most 256 KB"); return; }
                String[] names = PhonePath.split(path);
                if (names == null || names.length == 0) { call.reject("bad path"); return; }
                String last = names[names.length - 1];
                Found parent = find(tree, Arrays.copyOf(names, names.length - 1));
                if (parent == null || !Document.MIME_TYPE_DIR.equals(parent.mime)) { call.reject("no such folder"); return; }
                Found hit = find(tree, names);
                if (hit != null && Document.MIME_TYPE_DIR.equals(hit.mime)) { call.reject("that is a folder"); return; }
                ContentResolver cr = getContext().getContentResolver();
                Uri docUri;
                boolean created = hit == null;
                if (created) {
                    docUri = DocumentsContract.createDocument(cr,
                        DocumentsContract.buildDocumentUriUsingTree(tree, parent.doc), mimeFor(last), last);
                    if (docUri == null) { call.reject("Android could not create the file"); return; }
                } else {
                    docUri = DocumentsContract.buildDocumentUriUsingTree(tree, hit.doc);
                }
                try (OutputStream out = cr.openOutputStream(docUri, "wt")) {
                    if (out == null) { call.reject("could not open the file"); return; }
                    out.write(data);
                }
                // The provider may have changed the name it gave the file, so report the name it really has.
                JSObject r = new JSObject();
                r.put("created", created);
                r.put("name", name(tree, DocumentsContract.getDocumentId(docUri)));
                r.put("bytes", data.length);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("could not write the file: " + e.getMessage());
            }
        });
    }
}
