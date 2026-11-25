"""Transcribe wav files with Whisper: python whisper.py <model> <file>...  ->  one JSON object {file: text} on stdout."""
import json, sys, torch, soundfile as sf, librosa
from transformers import pipeline

model, files = sys.argv[1], sys.argv[2:]
asr = pipeline("automatic-speech-recognition", model=model, torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
               device=0 if torch.cuda.is_available() else -1)
out = {}
for f in files:
    a, sr = sf.read(f, dtype="float32")
    if a.ndim > 1: a = a.mean(axis=1)
    if sr != 16000: a = librosa.resample(a, orig_sr=sr, target_sr=16000)
    out[f] = asr({"raw": a, "sampling_rate": 16000}, generate_kwargs={"task": "transcribe"})["text"].strip()
sys.stdout.write("\n@@JSON@@" + json.dumps(out))
