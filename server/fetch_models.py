"""One-time download of the models Grisaille uses, into HF_HOME (default ~/.cache/huggingface;
set HF_HOME to use another drive).

    .venv/bin/python server/fetch_models.py

Stable Diffusion 1.5 (fp16 weights only), ControlNet 1.1 tile and depth, and the LCM-LoRA used by the
untested-in-the-page fast mode. About 6 GB.
"""
from huggingface_hub import snapshot_download

from models import SD, CN_TILE, CN_DEPTH, LCM_LORA

SD_FILES = ["model_index.json", "scheduler/*", "tokenizer/*", "feature_extractor/*",
            "text_encoder/config.json", "text_encoder/model.fp16.safetensors",
            "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors",
            "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors"]
CN_FILES = ["config.json", "diffusion_pytorch_model.safetensors", "diffusion_pytorch_model.bin"]

for repo, pats in [(SD, SD_FILES), (CN_TILE, CN_FILES), (CN_DEPTH, CN_FILES), (LCM_LORA, ["*.safetensors"])]:
    p = snapshot_download(repo, allow_patterns=pats)
    print("ok", repo, p, flush=True)
