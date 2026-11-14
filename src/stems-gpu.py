"""High-quality stem separation on an NVIDIA GPU (PyTorch + CUDA), two passes:

1. A BS-RoFormer model splits vocals from the instrumental (best open vocal model).
2. HT-Demucs fine-tuned splits that instrumental into drums / bass / other.

Writes drums.wav, bass.wav, other.wav, vocals.wav (16-bit stereo 44.1 kHz) and,
last, stems.json into the output folder: the same cache the app already reads.
Prints "PROGRESS <done> <total>" lines for the app.

Usage: python stems-gpu.py <input.wav> <out_dir> <model_dir> <vocal_model> <split_model>
   or: python stems-gpu.py --serve <model_dir> <vocal_model> <split_model>

With --serve it stays running and keeps both models loaded on the GPU: each line on stdin
is one job, {"input": "<input.wav>", "out": "<out_dir>"}, answered with PROGRESS lines and
then "DONE" or "FAIL <reason>". Starting Python, importing PyTorch and loading two models
costs many seconds; paying that once instead of once per track is most of the saving.
"""
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np
import soundfile as sf

# audio-separator calls "ffmpeg" by name: use the copy that lives in <env>/bin.
os.environ["PATH"] = os.path.join(os.path.dirname(os.path.dirname(sys.executable)), "bin") + os.pathsep + os.environ.get("PATH", "")
from audio_separator.separator import Separator  # noqa: E402


def progress(done, total):
    print(f"PROGRESS {done} {total}", flush=True)


def find(files, *tags):
    for tag in tags:
        for f in files:
            if f"({tag.lower()})" in os.path.basename(f).lower():  # models differ in case: (Vocals) / (vocals)
                return f
    raise RuntimeError(f"separator produced no {'/'.join(tags)} stem: {files}")


def read(path):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    if sr != 44100:
        raise RuntimeError(f"unexpected sample rate {sr} in {path}")
    return data if data.shape[1] == 2 else np.repeat(data[:, :1], 2, axis=1)


def write(path, data, n):
    data = data[:n] if len(data) >= n else np.pad(data, ((0, n - len(data)), (0, 0)))
    tmp = path + ".tmp.wav"
    sf.write(tmp, np.clip(data, -1, 1), 44100, subtype="PCM_16")
    os.replace(tmp, path)


class Stems:
    """The two separators, each loaded once (on first use) and kept."""

    def __init__(self, model_dir, vocal_model, split_model):
        self.model_dir, self.vocal_model, self.split_model = model_dir, vocal_model, split_model
        self.work = tempfile.mkdtemp(prefix="cdj-stems-")
        self.loaded = {}

    def separator(self, model):
        if model not in self.loaded:
            sep = Separator(output_dir=self.work, model_file_dir=self.model_dir, output_format="WAV", sample_rate=44100, log_level=30)
            sep.load_model(model_filename=model)
            self.loaded[model] = sep
        return self.loaded[model]

    def separate(self, src, out_dir):
        t0 = time.time()
        work = self.work
        try:
            progress(0, 3)
            vocal = self.separator(self.vocal_model)
            progress(1, 3)
            first = [os.path.join(work, f) for f in vocal.separate(src)]
            vocals = find(first, "Vocals")
            # Vocal models name the rest "Instrumental" or "Other". Rename it so the second pass's
            # file names don't carry "(other)" and get mistaken for its own Other stem.
            instrumental = os.path.join(work, "instrumental.wav")
            os.replace(find(first, "Instrumental", "Other"), instrumental)
            progress(2, 3)
            split = self.separator(self.split_model)
            second = [os.path.join(work, f) for f in split.separate(instrumental) if "instrumental_(" in os.path.basename(f)]
            progress(3, 3)

            n = sf.info(src).frames
            os.makedirs(out_dir, exist_ok=True)
            write(os.path.join(out_dir, "vocals.wav"), read(vocals), n)
            write(os.path.join(out_dir, "drums.wav"), read(find(second, "Drums")), n)
            write(os.path.join(out_dir, "bass.wav"), read(find(second, "Bass")), n)
            # Whatever Demucs still calls "vocals" in the instrumental is leftover music: keep it in "other".
            other = read(find(second, "Other"))
            rest = read(find(second, "Vocals"))
            m = min(len(other), len(rest))
            write(os.path.join(out_dir, "other.wav"), other[:m] + rest[:m], n)
            with open(os.path.join(out_dir, "stems.json"), "w") as f:
                json.dump({"model": f"{self.vocal_model} + {self.split_model}", "device": "cuda", "sampleRate": 44100, "ms": int((time.time() - t0) * 1000)}, f)
        finally:
            # The work folder stays (the separators write there); its files don't.
            for name in os.listdir(work):
                try:
                    os.remove(os.path.join(work, name))
                except OSError:
                    pass

    def close(self):
        shutil.rmtree(self.work, ignore_errors=True)


def serve(model_dir, vocal_model, split_model):
    stems = Stems(model_dir, vocal_model, split_model)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                job = json.loads(line)
                stems.separate(job["input"], job["out"])
                print("DONE", flush=True)
            except Exception as err:  # one bad track must not take the server down
                print("FAIL " + " ".join(str(err).split())[:500], flush=True)
    finally:
        stems.close()


def main():
    if sys.argv[1] == "--serve":
        return serve(*sys.argv[2:5])
    src, out_dir, model_dir, vocal_model, split_model = sys.argv[1:6]
    stems = Stems(model_dir, vocal_model, split_model)
    try:
        stems.separate(src, out_dir)
    finally:
        stems.close()


if __name__ == "__main__":
    main()
