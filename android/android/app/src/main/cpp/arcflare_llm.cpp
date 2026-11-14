// The on-phone chat engine behind LocalAiPlugin (LlamaEngine.java): one model, one conversation, one answer at a time.
//
// The token loop follows llama.cpp's examples/llama.android (lib/src/main/cpp/ai_chat.cpp at b12387), MIT License,
// Copyright (c) 2023-2026 The ggml authors. Written again for this app: each turn gets the whole conversation and
// reuses whatever prefix is still in the cache, thinking is switched off, text crosses JNI as UTF-8 bytes (JNI's own
// "modified UTF-8" would break emoji), and a flag stops an answer between two tokens.
#include <jni.h>
#include <android/log.h>

#include <algorithm>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include "chat.h"
#include "common.h"
#include "llama.h"
#include "sampling.h"

#define TAG "arcflare-llm"

static std::mutex g_mu;
static llama_model *g_model = nullptr;
static llama_context *g_ctx = nullptr;
static common_chat_templates_ptr g_tmpls;
static common_sampler *g_smpl = nullptr;
static std::vector<llama_token> g_cached;  // the tokens in the KV cache, in order
static std::atomic<bool> g_stop{false};
static int g_left = 0;                     // tokens this answer may still add
static std::string g_pending;              // the start of a UTF-8 character split across two tokens
static bool g_failed = false;              // the last answer ended because a step failed, not because it was done
static const int BATCH = 512;

static void log_cb(ggml_log_level level, const char *text, void *) {
    if (level >= GGML_LOG_LEVEL_WARN) __android_log_print(level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN, TAG, "%s", text);
}

static std::string from_bytes(JNIEnv *env, jbyteArray a) {
    if (!a) return "";
    jsize n = env->GetArrayLength(a);
    std::string s(n, '\0');
    env->GetByteArrayRegion(a, 0, n, reinterpret_cast<jbyte *>(&s[0]));
    return s;
}

static jbyteArray to_bytes(JNIEnv *env, const std::string &s) {
    jbyteArray a = env->NewByteArray((jsize) s.size());
    env->SetByteArrayRegion(a, 0, (jsize) s.size(), reinterpret_cast<const jbyte *>(s.data()));
    return a;
}

/** Length of the longest prefix of s that does not end in the middle of a UTF-8 character. */
static size_t complete_utf8(const std::string &s) {
    size_t n = s.size();
    for (size_t back = 1; back <= 4 && back <= n; back++) {
        unsigned char c = (unsigned char) s[n - back];
        if ((c & 0xC0) == 0x80) continue;                    // a continuation byte: keep looking for the lead
        size_t need = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        return back >= need ? n : n - back;
    }
    return n;
}

static void free_all() {
    if (g_smpl) { common_sampler_free(g_smpl); g_smpl = nullptr; }
    g_tmpls.reset();
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_cached.clear();
}

extern "C" JNIEXPORT void JNICALL
Java_net_arcflare_app_LlamaEngine_nInit(JNIEnv *env, jclass, jstring jlibdir) {
    llama_log_set(log_cb, nullptr);
    const char *dir = env->GetStringUTFChars(jlibdir, nullptr);
    ggml_backend_load_all_from_path(dir);  // every CPU variant; ggml keeps the best one this CPU can run
    env->ReleaseStringUTFChars(jlibdir, dir);
    llama_backend_init();
}

extern "C" JNIEXPORT jstring JNICALL
Java_net_arcflare_app_LlamaEngine_nSystemInfo(JNIEnv *env, jclass) {
    return env->NewStringUTF(llama_print_system_info());
}

/** null when loaded, else what went wrong. */
extern "C" JNIEXPORT jstring JNICALL
Java_net_arcflare_app_LlamaEngine_nLoad(JNIEnv *env, jclass, jstring jpath, jint threads, jint n_ctx) {
    std::lock_guard<std::mutex> lock(g_mu);
    free_all();
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    llama_model_params mp = llama_model_default_params();
    g_model = llama_model_load_from_file(path, mp);
    env->ReleaseStringUTFChars(jpath, path);
    if (!g_model) return env->NewStringUTF("could not read the model file");
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t) n_ctx;
    cp.n_batch = BATCH;
    cp.n_ubatch = BATCH;
    cp.n_threads = threads;
    cp.n_threads_batch = threads;
    g_ctx = llama_init_from_model(g_model, cp);
    if (!g_ctx) { free_all(); return env->NewStringUTF("not enough memory for this model"); }
    g_tmpls = common_chat_templates_init(g_model, "");
    // Arc Pocket's sampling (lib/arcs/arc-pocket.Modelfile; android/test/localai.test.js keeps them equal), which is
    // Qwen3's own advice for chat without thinking. shortcut: one set for every model, until a second family is added.
    common_params_sampling sp;
    sp.temp = 0.7f;
    sp.top_p = 0.8f;
    sp.top_k = 20;
    sp.min_p = 0.0f;
    g_smpl = common_sampler_init(g_model, sp);
    if (!g_smpl) { free_all(); return env->NewStringUTF("could not set up sampling"); }
    return nullptr;
}

/**
 * Starts an answer to the conversation (roles[i], UTF-8 contents[i]). Tokens already in the cache from the previous
 * turn are kept up to the first difference. null when ready, else what went wrong.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_net_arcflare_app_LlamaEngine_nBegin(JNIEnv *env, jclass, jobjectArray roles, jobjectArray contents, jint max_tokens) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_ctx) return env->NewStringUTF("no model is loaded");
    common_chat_templates_inputs in;
    in.use_jinja = true;
    in.enable_thinking = false;
    in.add_generation_prompt = true;
    jsize n = env->GetArrayLength(roles);
    for (jsize i = 0; i < n; i++) {
        common_chat_msg m;
        auto jr = (jstring) env->GetObjectArrayElement(roles, i);
        const char *r = env->GetStringUTFChars(jr, nullptr);
        m.role = r;
        env->ReleaseStringUTFChars(jr, r);
        env->DeleteLocalRef(jr);  // ART allows 512 local references per call; a long chat has more messages
        auto jc = (jbyteArray) env->GetObjectArrayElement(contents, i);
        m.content = from_bytes(env, jc);
        env->DeleteLocalRef(jc);
        in.messages.push_back(m);
    }
    common_chat_params p;
    try {
        p = common_chat_templates_apply(g_tmpls.get(), in);
    } catch (const std::exception &e) {
        return env->NewStringUTF((std::string("the model's chat template failed: ") + e.what()).c_str());
    }
    // The template's own text may hold control tokens; what people typed is never read as one.
    const llama_vocab *vocab = llama_model_get_vocab(g_model);
    std::vector<llama_token> toks;
    bool first = true;
    for (const auto &part : p.prompt.parts) {
        auto t = common_tokenize(vocab, part.text, first, !part.is_input);
        toks.insert(toks.end(), t.begin(), t.end());
        first = false;
    }
    const int n_ctx = (int) llama_n_ctx(g_ctx);
    if (toks.empty()) return env->NewStringUTF("nothing to answer");
    if ((int) toks.size() + max_tokens > n_ctx) return env->NewStringUTF("TOO_LONG");
    size_t keep = 0;
    while (keep < g_cached.size() && keep < toks.size() && g_cached[keep] == toks[keep]) keep++;
    if (keep == toks.size()) keep--;  // the last token is always decoded again, for its logits
    llama_memory_seq_rm(llama_get_memory(g_ctx), 0, (llama_pos) keep, -1);
    g_cached.resize(keep);
    for (size_t i = keep; i < toks.size(); i += BATCH) {
        int len = (int) std::min((size_t) BATCH, toks.size() - i);
        if (llama_decode(g_ctx, llama_batch_get_one(toks.data() + i, len)) != 0) {
            llama_memory_clear(llama_get_memory(g_ctx), true);
            g_cached.clear();
            return env->NewStringUTF("the phone could not read the whole conversation (memory)");
        }
        g_cached.insert(g_cached.end(), toks.begin() + (long) i, toks.begin() + (long) i + len);
    }
    common_sampler_reset(g_smpl);
    g_left = max_tokens;
    g_pending.clear();
    g_stop = false;
    g_failed = false;
    return nullptr;
}

/** The next piece of the answer as UTF-8 bytes (possibly empty), or null when it is finished or stopped. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_net_arcflare_app_LlamaEngine_nNext(JNIEnv *env, jclass) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_ctx || g_stop || g_left <= 0 || (int) g_cached.size() >= (int) llama_n_ctx(g_ctx) - 1) return nullptr;
    llama_token t = common_sampler_sample(g_smpl, g_ctx, -1);
    common_sampler_accept(g_smpl, t, true);
    if (llama_vocab_is_eog(llama_model_get_vocab(g_model), t)) return nullptr;
    if (llama_decode(g_ctx, llama_batch_get_one(&t, 1)) != 0) { g_failed = true; return nullptr; }
    g_cached.push_back(t);
    g_left--;
    g_pending += common_token_to_piece(g_ctx, t, false);
    size_t cut = complete_utf8(g_pending);
    std::string out = g_pending.substr(0, cut);
    g_pending.erase(0, cut);
    return to_bytes(env, out);
}

/** Did the last answer end because a step failed (memory), rather than because it was finished or stopped? */
extern "C" JNIEXPORT jboolean JNICALL
Java_net_arcflare_app_LlamaEngine_nFailed(JNIEnv *, jclass) {
    std::lock_guard<std::mutex> lock(g_mu);
    return g_failed;
}

extern "C" JNIEXPORT void JNICALL
Java_net_arcflare_app_LlamaEngine_nStop(JNIEnv *, jclass) { g_stop = true; }

extern "C" JNIEXPORT void JNICALL
Java_net_arcflare_app_LlamaEngine_nFree(JNIEnv *, jclass) {
    g_stop = true;
    std::lock_guard<std::mutex> lock(g_mu);
    free_all();
}
