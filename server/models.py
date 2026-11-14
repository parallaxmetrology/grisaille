"""Model ids and the three ways a value plan is handed to Stable Diffusion 1.5, plus masked repair.

It grew from an earlier experiment in which a picture's own tone, handed to ControlNet, anchored
generation better than a depth map did. Grisaille hands it a value plan instead of a picture.
"""
import threading

# Models go wherever HF_HOME points (default: ~/.cache/huggingface). Set it to put them on another drive.

SD = "stable-diffusion-v1-5/stable-diffusion-v1-5"
CN_TILE = "lllyasviel/control_v11f1e_sd15_tile"
CN_DEPTH = "lllyasviel/control_v11f1p_sd15_depth"
LCM_LORA = "latent-consistency/lcm-lora-sdv1-5"

NEGATIVE = "lowres, blurry, watermark, text, signature, frame, border"

MODES = {
    # the plan is the underpainting: img2img from it, and the tile ControlNet holds it as well
    "underpaint": dict(cn="tile", kind="img2img"),
    # nothing but the tile ControlNet: generation starts from noise and is pulled toward the plan
    "tile": dict(cn="tile", kind="txt2img"),
    # the plan handed over as if it were depth (dark = near by default); shapes, not values
    "depth": dict(cn="depth", kind="txt2img"),
}

# fast = LCM-LoRA: few steps, low guidance
FAST_STEPS, FAST_GUIDANCE = 6, 1.5


class Engine:
    """Loads lazily, keeps one pipeline per (controlnet, kind) sharing one set of weights, one job at a time."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pipes = {}
        self.cns = {}
        self.device = None
        self.status = "idle"
        self.sched = {}
        self.lcm_loaded = False

    def _device(self):
        import torch
        if self.device is None:
            self.device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        return self.device

    def _pipe(self, cn, kind):
        import torch
        from diffusers import (ControlNetModel, LCMScheduler, StableDiffusionControlNetImg2ImgPipeline,
                               StableDiffusionControlNetInpaintPipeline, StableDiffusionControlNetPipeline,
                               UniPCMultistepScheduler)
        key = (cn, kind)
        if key in self.pipes:
            return self.pipes[key]
        dev = self._device()
        dtype = torch.float32 if dev == "cpu" else torch.float16
        if cn not in self.cns:
            self.status = f"loading ControlNet {cn}"
            self.cns[cn] = ControlNetModel.from_pretrained(CN_TILE if cn == "tile" else CN_DEPTH, torch_dtype=dtype).to(dev)
        Pipe = {"txt2img": StableDiffusionControlNetPipeline, "img2img": StableDiffusionControlNetImg2ImgPipeline,
                "inpaint": StableDiffusionControlNetInpaintPipeline}[kind]
        base = next(iter(self.pipes.values()), None)
        self.status = "loading Stable Diffusion 1.5"
        if base is not None:   # share weights with the pipeline already loaded
            pipe = Pipe(vae=base.vae, text_encoder=base.text_encoder, tokenizer=base.tokenizer, unet=base.unet,
                        controlnet=self.cns[cn], scheduler=base.scheduler, safety_checker=None,
                        feature_extractor=None, requires_safety_checker=False)
        else:
            pipe = Pipe.from_pretrained(SD, controlnet=self.cns[cn], torch_dtype=dtype, variant="fp16",
                                        safety_checker=None, requires_safety_checker=False)
            self.sched["normal"] = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
            self.sched["fast"] = LCMScheduler.from_config(pipe.scheduler.config)
        pipe = pipe.to(dev)
        pipe.set_progress_bar_config(disable=True)
        self.pipes[key] = pipe
        return pipe

    def _speed(self, pipe, fast):
        """Switch the shared UNet between normal and LCM-LoRA, and set this pipe's scheduler."""
        if fast and not self.lcm_loaded:
            self.status = "loading fast mode (LCM-LoRA)"
            pipe.load_lora_weights(LCM_LORA, adapter_name="lcm")
            self.lcm_loaded = True
        if self.lcm_loaded:
            if fast:
                pipe.unet.enable_adapters()
            else:
                pipe.unet.disable_adapters()
        pipe.scheduler = self.sched["fast" if fast else "normal"]

    def _run(self, pipe, progress, total, **kw):
        import torch

        def cb(p, i, t, k):
            if progress:
                progress(i + 1, total)
            return k
        self.status = "generating"
        if progress:   # reset here, under the lock, so a queued request cannot zero a running job's progress
            progress(0, total)
        try:
            return pipe(callback_on_step_end=cb, **kw).images[0]
        finally:
            self.status = "idle"
            if self.device == "mps":
                torch.mps.empty_cache()

    def generate(self, plan, prompt, mode="underpaint", strength=0.75, control=1.0, seed=11,
                 steps=25, guidance=7.0, invert_depth=False, fast=False, progress=None):
        """plan: PIL greyscale/RGB image at the output size. Returns a PIL RGB image."""
        import torch
        from PIL import ImageOps
        spec = MODES[mode]
        if fast:
            steps, guidance = FAST_STEPS, FAST_GUIDANCE
        with self.lock:
            pipe = self._pipe(spec["cn"], spec["kind"])
            self._speed(pipe, fast)
            cond = plan.convert("RGB")
            if spec["cn"] == "depth":
                # ControlNet depth reads white as near. A value plan's darks are usually the figure,
                # so the default hands over darks as near; invert_depth flips that.
                cond = cond if invert_depth else ImageOps.invert(cond)
            n = int(steps)
            kw = dict(prompt=prompt, negative_prompt=NEGATIVE, num_inference_steps=n, guidance_scale=float(guidance),
                      controlnet_conditioning_scale=float(control), generator=torch.Generator("cpu").manual_seed(int(seed)))
            if spec["kind"] == "img2img":
                total = max(1, int(n * float(strength)))   # img2img skips the first steps
                return self._run(pipe, progress, total, image=plan.convert("RGB"), control_image=cond, strength=float(strength), **kw)
            return self._run(pipe, progress, n, image=cond, width=plan.width, height=plan.height, **kw)

    def repair(self, image, mask, prompt, strength=0.6, control=0.8, seed=11, steps=25, guidance=7.0,
               fast=False, progress=None):
        """Repaint only the white of `mask` over `image` (already value-corrected by the page), held by the
        tile ControlNet to that corrected image. Pixels outside the mask come back unchanged."""
        import numpy as np
        import torch
        from PIL import Image, ImageFilter
        if fast:
            steps, guidance = FAST_STEPS, FAST_GUIDANCE
        img = image.convert("RGB")
        m = mask.convert("L")
        with self.lock:
            pipe = self._pipe("tile", "inpaint")
            self._speed(pipe, fast)
            n = int(steps)
            out = self._run(pipe, progress, max(1, int(n * float(strength))), prompt=prompt, negative_prompt=NEGATIVE,
                            image=img, mask_image=m, control_image=img, strength=float(strength),
                            num_inference_steps=n, guidance_scale=float(guidance),
                            controlnet_conditioning_scale=float(control),
                            generator=torch.Generator("cpu").manual_seed(int(seed)),
                            width=img.width, height=img.height)
        # composite through a softened mask so nothing outside it moves (the VAE round trip would). The
        # softening is kept inside the mask: a plain blur spilled ~8 px past it (up to ~20/255, seen 13 Nov).
        hard = np.asarray(m, dtype=np.float32)[..., None] / 255
        soft = np.asarray(m.filter(ImageFilter.GaussianBlur(3)), dtype=np.float32)[..., None] / 255 * hard
        a, b = np.asarray(img, dtype=np.float32), np.asarray(out.resize(img.size), dtype=np.float32)
        return Image.fromarray(np.clip(a * (1 - soft) + b * soft, 0, 255).astype(np.uint8))
