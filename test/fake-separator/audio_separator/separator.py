"""Stand-in for the real audio-separator package, for test/stems-gpu.js: no models, no GPU.

It writes stems named the way the real models name them, logs each model load to
$CDJ_FAKE_SEPARATOR_LOG (so the test can count them), and fails on inputs under 0.1 s.
"""
import os

import numpy as np
import soundfile as sf


class Separator:
    def __init__(self, output_dir, **_):
        self.out = output_dir
        self.model = None

    def load_model(self, model_filename):
        self.model = model_filename
        with open(os.environ["CDJ_FAKE_SEPARATOR_LOG"], "a") as f:
            f.write(f"{os.getpid()} load {model_filename}\n")

    def separate(self, src):
        data, sr = sf.read(src, dtype="float32", always_2d=True)
        if len(data) < sr // 10:
            raise RuntimeError("input too short")
        base = os.path.splitext(os.path.basename(src))[0]
        tags = ["Vocals", "Instrumental"] if "vocal" in self.model else ["drums", "bass", "other", "vocals"]
        names = []
        for i, tag in enumerate(tags):
            name = f"{base}_({tag})_{self.model}.wav"
            sf.write(os.path.join(self.out, name), data * (0.1 * (i + 1)), sr, subtype="PCM_16")
            names.append(name)
        return names
