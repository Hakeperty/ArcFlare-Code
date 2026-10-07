"""ArcFlare's generation worker: image (or text) -> 3D mesh.

Spawned by lib/gen/index.js with one argument, a JSON spec file. Writes one
JSON object per line to stdout -- {"event": "stage" | "info" | "done" | "error"}
-- and nothing else. Everything the pipelines print goes to stderr, where the
Node side keeps only the tail.

Imports are deferred to the branch that needs them: `check` must work, and
say what is missing, in an environment where half of this cannot import.
"""

import json
import os
import sys
import time
import traceback

_REAL_STDOUT = sys.stdout
# Libraries print to stdout freely; anything that is not ours goes to stderr so
# the protocol stream stays parseable.
sys.stdout = sys.stderr


def emit(event, **kw):
    kw["event"] = event
    _REAL_STDOUT.write(json.dumps(kw) + "\n")
    _REAL_STDOUT.flush()


def stage(name, **kw):
    emit("stage", stage=name, t=round(time.time(), 2), **kw)


# --------------------------------------------------------------------- torch --

def pick_device(want=None):
    import torch
    if want:
        return want
    # ROCm builds answer to torch.cuda too, which is what we want.
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def torch_info():
    try:
        import torch
    except Exception as e:  # noqa: BLE001 - any import failure is the answer
        return {"torch": None, "error": str(e)}
    info = {"torch": torch.__version__, "device": pick_device()}
    if torch.cuda.is_available():
        info["device_name"] = torch.cuda.get_device_name(0)
        info["hip"] = getattr(torch.version, "hip", None)
        info["cuda"] = torch.version.cuda
        free, total = torch.cuda.mem_get_info()
        info["vram_free_gb"] = round(free / 1e9, 1)
        info["vram_total_gb"] = round(total / 1e9, 1)
    return info


# --------------------------------------------------------------------- check --

FAMILY_IMPORTS = {
    "hunyuan3d-2": ["hy3dgen.shapegen"],
    "hunyuan3d-2.1": ["hy3dshape.pipelines"],
    "triposr": ["tsr.system"],
    "qwen3-tts": ["qwen_tts", "soundfile"],
    "kokoro": ["kokoro", "soundfile"],
    "chatterbox": ["chatterbox.tts"],
    "voxcpm": ["voxcpm", "soundfile"],
    "outetts": ["outetts"],
}


def do_check(spec):
    info = torch_info()
    problems = []
    if not info.get("torch"):
        problems.append("torch is not installed: " + info.get("error", ""))
    elif info.get("device") == "cpu":
        problems.append("torch sees no GPU -- generation will run on the CPU and take many minutes")
    family = spec.get("family")
    imports = {}
    for mod in FAMILY_IMPORTS.get(family, []):
        try:
            __import__(mod)
            imports[mod] = "ok"
        except Exception as e:  # noqa: BLE001
            imports[mod] = f"{type(e).__name__}: {e}"
            problems.append(f"cannot import {mod}: {type(e).__name__}: {e}")
    emit("done", python=sys.executable, version=sys.version.split()[0],
         imports=imports, problems=problems, **info)


# ------------------------------------------------------------------- helpers --

def load_image(spec):
    from PIL import Image
    if spec.get("image"):
        stage("image", source=spec["image"])
        return Image.open(spec["image"])
    stage("text-to-image", prompt=spec["prompt"])
    # Hunyuan3D-2's own text-to-image front end. Heavy, but it is the one the
    # shape model was trained alongside, and it is tuned for a single centred
    # object on a plain background -- the image a mesh can be made from.
    from hy3dgen.text2image import HunyuanDiTPipeline
    t2i = HunyuanDiTPipeline("Tencent-Hunyuan/HunyuanDiT-v1.1-Diffusers-Distilled")
    img = t2i(spec["prompt"])
    del t2i
    free_vram()
    return img


def free_vram():
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def needs_matting(image):
    """A photo with an opaque background needs matting; a cut-out does not."""
    if image.mode != "RGBA":
        return True
    alpha = image.getchannel("A")
    lo, _ = alpha.getextrema()
    return lo == 255


def finish(mesh, spec, **extra):
    out = spec["out"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    stage("export", file=out)
    mesh.export(out)
    faces = getattr(mesh, "faces", None)
    verts = getattr(mesh, "vertices", None)
    emit("done", file=out,
         faces=int(len(faces)) if faces is not None else None,
         vertices=int(len(verts)) if verts is not None else None,
         **extra)


# ----------------------------------------------------------------- hunyuan --

def gen_hunyuan(spec, device):
    import torch
    family = spec["family"]
    if family == "hunyuan3d-2.1":
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
        from hy3dshape.rembg import BackgroundRemover
        try:
            from hy3dshape.postprocessors import FloaterRemover, DegenerateFaceRemover, FaceReducer
        except Exception:  # noqa: BLE001 - layout moved between releases
            FloaterRemover = DegenerateFaceRemover = FaceReducer = None
    else:
        from hy3dgen.shapegen import (Hunyuan3DDiTFlowMatchingPipeline, FloaterRemover,
                                      DegenerateFaceRemover, FaceReducer)
        from hy3dgen.rembg import BackgroundRemover

    image = load_image(spec)
    if spec.get("removeBackground", True) and needs_matting(image):
        stage("remove-background")
        image = BackgroundRemover()(image.convert("RGB"))
    elif image.mode != "RGBA":
        image = image.convert("RGBA")

    stage("load-model", repo=spec["hf"], subfolder=spec.get("subfolder"))
    kwargs = {"subfolder": spec["subfolder"], "use_safetensors": True, "device": device}
    if family == "hunyuan3d-2.1":
        pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(spec["hf"], **kwargs)
    else:
        try:
            pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(spec["hf"], variant="fp16", **kwargs)
        except Exception:  # noqa: BLE001 - not every subfolder ships an fp16 variant
            pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(spec["hf"], **kwargs)
    if spec.get("turbo") and hasattr(pipe, "enable_flashvdm"):
        pipe.enable_flashvdm()

    stage("shape", steps=spec["steps"], octree=spec["octree"])
    gen = torch.Generator(device="cpu").manual_seed(int(spec["seed"]))
    t0 = time.time()
    mesh = pipe(image=image, num_inference_steps=int(spec["steps"]),
                octree_resolution=int(spec["octree"]), num_chunks=20000,
                generator=gen, output_type="trimesh")[0]
    shape_s = round(time.time() - t0, 1)

    stage("cleanup")
    if FloaterRemover:
        mesh = FloaterRemover()(mesh)
        mesh = DegenerateFaceRemover()(mesh)
        if spec.get("faces"):
            mesh = FaceReducer()(mesh, max_facenum=int(spec["faces"]))

    if spec.get("texture"):
        del pipe
        free_vram()
        stage("texture")
        from hy3dgen.texgen import Hunyuan3DPaintPipeline
        paint = Hunyuan3DPaintPipeline.from_pretrained("tencent/Hunyuan3D-2")
        mesh = paint(mesh, image=image)

    finish(mesh, spec, shape_seconds=shape_s, device=device)


# ----------------------------------------------------------------- triposr --

def gen_triposr(spec, device):
    import numpy as np
    import torch
    from PIL import Image
    from tsr.system import TSR
    from tsr.utils import remove_background, resize_foreground

    image = load_image(spec)
    if spec.get("removeBackground", True) and needs_matting(image):
        stage("remove-background")
        import rembg
        image = remove_background(image.convert("RGB"), rembg.new_session())
    image = resize_foreground(image.convert("RGBA"), 0.85)
    # TripoSR wants RGB on mid-grey, not alpha.
    arr = np.array(image).astype(np.float32) / 255.0
    arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
    image = Image.fromarray((arr * 255.0).astype(np.uint8))

    stage("load-model", repo=spec["hf"])
    model = TSR.from_pretrained(spec["hf"], config_name="config.yaml", weight_name="model.ckpt")
    model.renderer.set_chunk_size(8192)
    model.to(device)

    stage("shape", resolution=spec["octree"])
    t0 = time.time()
    with torch.no_grad():
        codes = model([image], device=device)
    try:
        meshes = model.extract_mesh(codes, True, resolution=int(spec["octree"]))
    except TypeError:  # older TSR without the vertex-colour flag
        meshes = model.extract_mesh(codes, resolution=int(spec["octree"]))
    finish(meshes[0], spec, shape_seconds=round(time.time() - t0, 1), device=device)


# ----------------------------------------------------------------------- tts --
#
# Each branch follows its model card's own minimal example, and ends in
# finish_audio(), which measures what was actually written. Models disagree on
# what they return (numpy, a torch tensor, a list of chunks), so to_numpy()
# normalises before anything is measured or saved.

def to_numpy(audio):
    import numpy as np
    if hasattr(audio, "detach"):
        audio = audio.detach().float().cpu().numpy()
    audio = np.asarray(audio, dtype="float32")
    # (1, n) or (n, 1) mono → (n,)
    return audio.squeeze()


def finish_audio(out, **extra):
    import soundfile as sf
    info = sf.info(out)
    if info.frames == 0:
        raise RuntimeError("the model produced no audio")
    emit("done", file=out, seconds=round(info.frames / info.samplerate, 2),
         sample_rate=info.samplerate, **extra)


# Qwen3-TTS takes language names; accept the short codes people type.
QWEN_LANGS = {"en": "English", "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "de": "German",
              "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian"}


def tts_qwen3(spec, device):
    import torch
    import soundfile as sf
    from qwen_tts import Qwen3TTSModel

    stage("load-model", repo=spec["hf"])
    gpu = device.startswith("cuda")
    kwargs = {"device_map": "cuda:0" if gpu else device,
              "dtype": torch.bfloat16 if gpu else torch.float32}
    # flash-attn is optional and rarely installed (never on Windows); sdpa is
    # torch's own attention and needs nothing extra.
    try:
        model = Qwen3TTSModel.from_pretrained(spec["hf"], attn_implementation="sdpa", **kwargs)
    except TypeError:
        model = Qwen3TTSModel.from_pretrained(spec["hf"], **kwargs)

    lang = spec.get("lang") or "Auto"
    lang = QWEN_LANGS.get(lang.lower(), lang)
    stage("synthesize", language=lang)
    if spec.get("ref"):
        wavs, sr = model.generate_voice_clone(text=spec["text"], language=lang,
                                              ref_audio=spec["ref"], ref_text=spec.get("refText") or "")
    else:
        speakers = list(model.get_supported_speakers() or [])
        speaker = spec.get("voice") or (speakers[0] if speakers else None)
        if spec.get("voice") and speakers and spec["voice"] not in speakers:
            raise ValueError(f"no voice {spec['voice']!r}; this model has: {', '.join(speakers)}")
        kw = {"text": spec["text"], "language": lang, "speaker": speaker}
        if spec.get("instruct"):
            kw["instruct"] = spec["instruct"]
        wavs, sr = model.generate_custom_voice(**kw)
    sf.write(spec["out"], to_numpy(wavs[0]), sr)
    finish_audio(spec["out"], device=device, voice=spec.get("voice") or "default")


def tts_kokoro(spec, device):
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    voice = spec.get("voice") or "af_heart"
    # Kokoro voice names start with their language code: af_* is American
    # English, bf_* British, jf_* Japanese and so on.
    lang = spec.get("lang") or voice[0]
    stage("load-model", repo=spec["hf"])
    try:
        pipe = KPipeline(lang_code=lang, device=device)
    except TypeError:
        pipe = KPipeline(lang_code=lang)
    stage("synthesize", voice=voice)
    parts = [to_numpy(audio) for _, _, audio in pipe(spec["text"], voice=voice, speed=spec.get("speed") or 1)]
    if not parts:
        raise RuntimeError("Kokoro produced no audio for this text")
    sf.write(spec["out"], np.concatenate(parts), 24000)
    finish_audio(spec["out"], device=device, voice=voice)


def tts_chatterbox(spec, device):
    import soundfile as sf

    lang = (spec.get("lang") or "en").lower()
    stage("load-model", repo=spec["hf"])
    if lang != "en":
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        kw = {"language_id": lang}
    else:
        from chatterbox.tts import ChatterboxTTS
        model = ChatterboxTTS.from_pretrained(device=device)
        kw = {}
    if spec.get("ref"):
        kw["audio_prompt_path"] = spec["ref"]
    stage("synthesize", language=lang)
    wav = model.generate(spec["text"], **kw)
    sf.write(spec["out"], to_numpy(wav), model.sr)
    finish_audio(spec["out"], device=device, cloned=bool(spec.get("ref")))


def tts_voxcpm(spec, device):
    import soundfile as sf
    from voxcpm import VoxCPM

    stage("load-model", repo=spec["hf"])
    model = VoxCPM.from_pretrained(spec["hf"], load_denoiser=False)
    stage("synthesize")
    wav = model.generate(text=spec["text"], cfg_value=2.0, inference_timesteps=10)
    sf.write(spec["out"], to_numpy(wav), model.tts_model.sample_rate)
    finish_audio(spec["out"], device=device)


def tts_outetts(spec, device):
    from outetts import Interface, ModelConfig, GenerationConfig, Backend, Models

    stage("load-model", repo=spec["hf"])
    interface = Interface(ModelConfig.auto_config(model=Models.VERSION_1_0_SIZE_0_6B, backend=Backend.HF))
    if spec.get("ref"):
        stage("clone-voice", ref=spec["ref"])
        speaker = interface.create_speaker(spec["ref"])
    else:
        speaker = interface.load_default_speaker(spec.get("voice") or "EN-FEMALE-1-NEUTRAL")
    stage("synthesize")
    output = interface.generate(GenerationConfig(text=spec["text"], speaker=speaker))
    output.save(spec["out"])
    finish_audio(spec["out"], device=device, cloned=bool(spec.get("ref")))


TTS = {
    "qwen3-tts": tts_qwen3,
    "kokoro": tts_kokoro,
    "chatterbox": tts_chatterbox,
    "voxcpm": tts_voxcpm,
    "outetts": tts_outetts,
}


# ---------------------------------------------------------------------- main --

def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        spec = json.load(f)
    if spec.get("action") == "check":
        return do_check(spec)
    device = pick_device(spec.get("device"))
    emit("info", device=device, python=sys.executable)
    family = spec["family"]
    if spec.get("action") == "tts":
        if family not in TTS:
            raise ValueError(f"unknown speech family {family!r}")
        return TTS[family](spec, device)
    if family.startswith("hunyuan"):
        return gen_hunyuan(spec, device)
    if family == "triposr":
        return gen_triposr(spec, device)
    raise ValueError(f"unknown family {family!r}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - report every failure on the protocol
        traceback.print_exc()
        msg = f"{type(e).__name__}: {e}"
        if "out of memory" in str(e).lower():
            msg += " -- try a smaller model, a lower --octree, or close what else is on the GPU"
        emit("error", message=msg)
        sys.exit(1)
