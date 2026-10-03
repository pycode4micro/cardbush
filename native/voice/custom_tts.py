"""One local Qwen CustomVoice synthesis request; no downloads, microphone or custom model code."""
import base64
import contextlib
import json
import os
import sys

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1")


def event(kind, **fields):
    print(json.dumps(dict(cardbush_tts=1, type=kind, **fields)), flush=True)


def run():
    payload = json.loads(sys.stdin.buffer.read(32769).decode("utf-8"))
    stage = "dependencies"
    try:
        # Isolate diagnostic output from the PCM event stream. The parent does not forward logs.
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            import torch
            from qwen_tts import Qwen3TTSModel

            torch.set_num_threads(4)
            device = payload["device"]
            if device == "auto":
                device = "cuda" if torch.cuda.is_available() else "cpu"
            if device == "cuda" and not torch.cuda.is_available():
                event_code = "cuda"
                raise RuntimeError(event_code)
            stage = "model"
            model = Qwen3TTSModel.from_pretrained(
                payload["directory"], device_map="cuda:0" if device == "cuda" else "cpu",
                dtype=(torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16) if device == "cuda" else torch.float32,
                attn_implementation="sdpa", local_files_only=True, trust_remote_code=False, use_safetensors=True,
            )
            stage = "synthesis"
            with torch.inference_mode():
                waves, rate = model.generate_custom_voice(
                    text=payload["text"], speaker=payload["speaker"], language=payload["language"],
                    instruct=payload["instruction"], max_new_tokens=1536,
                )
            stage = "audio"
            pcm = np.asarray(waves[0], dtype=np.float32)
            if rate != 24000 or pcm.ndim != 1 or not 0 < pcm.size <= 6 * 1024 * 1024 or not np.isfinite(pcm).all():
                raise ValueError("invalid audio")
            raw = (np.clip(pcm, -1, 32767 / 32768) * 32768).astype("<i2").tobytes()
        for offset in range(0, len(raw), 48000):
            event("audio", sampleRate=rate, pcm=base64.b64encode(raw[offset:offset + 48000]).decode("ascii"))
        event("done")
    except Exception as error:
        code = "memory" if "out of memory" in str(error).lower() else "cuda" if str(error) == "cuda" else stage
        event("error", code=code)
        sys.exit(1)


if __name__ == "__main__":
    run()
