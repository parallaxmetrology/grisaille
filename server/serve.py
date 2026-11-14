"""Grisaille local server: serves the app and runs Stable Diffusion 1.5 + ControlNet on this machine.

    .venv/bin/python server/serve.py          # http://localhost:7569

Every generation is kept in runs/<stamp>/ with plan.png, out.png, params.json and (once the page has
read it) receipt.json.
"""
import base64
import io
import json
import os
import re
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from models import CN_DEPTH, CN_TILE, LCM_LORA, MODES, SD, Engine  # noqa: E402

PORT = int(os.environ.get("PORT", "7569"))
ENGINE = Engine()
PROGRESS = {"step": 0, "of": 0}
MAX_SIDE = 768


_READY = {}


def models_ready():
    """Whether the model files are in the cache. Cached once true: they do not vanish mid-session."""
    if _READY.get("models"):
        return True
    from huggingface_hub import try_to_load_from_cache
    need = [(SD, "unet/diffusion_pytorch_model.fp16.safetensors"), (SD, "vae/diffusion_pytorch_model.fp16.safetensors"),
            (SD, "text_encoder/model.fp16.safetensors")]
    got = lambda r, f: isinstance(try_to_load_from_cache(r, f), str)
    cn = all(got(r, "diffusion_pytorch_model.safetensors") or got(r, "diffusion_pytorch_model.bin") for r in (CN_TILE, CN_DEPTH))
    _READY["models"] = cn and all(got(r, f) for r, f in need)
    return _READY["models"]


def fast_ready():
    if "fast" not in _READY:
        from huggingface_hub import try_to_load_from_cache
        _READY["fast"] = isinstance(try_to_load_from_cache(LCM_LORA, "pytorch_lora_weights.safetensors"), str)
    return _READY["fast"]


# Only these are served as static files; everything else (server code, .venv, .git) is not.
STATIC = {"index.html", "css", "js", "runs", "examples"}


class BadRequest(ValueError):
    pass


def num(b, k, d, kind=float):
    try:
        return kind(b.get(k, d))
    except (TypeError, ValueError):
        raise BadRequest(f"{k} must be a number")


def flag(b, k):
    v = b.get(k, False)
    if not isinstance(v, bool):
        raise BadRequest(f"{k} must be true or false")
    return v


def image_field(b, k):
    v = b.get(k)
    if not isinstance(v, str) or "," not in v:
        raise BadRequest(f"{k} must be a PNG data URL")
    try:
        return decode_png(v)
    except Exception:
        raise BadRequest(f"{k} is not a readable image")


def decode_png(data_url):
    from PIL import Image
    b = base64.b64decode(data_url.split(",", 1)[1])
    return Image.open(io.BytesIO(b))


def png_url(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def log_message(self, fmt, *args):
        if "/api/status" not in str(args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/status"):
            return self._json({"status": ENGINE.status, "step": PROGRESS["step"], "of": PROGRESS["of"],
                               "ready": models_ready(), "fast": fast_ready(), "device": ENGINE.device,
                               "modes": list(MODES)})
        # serve only the page and its folders: resolve the path the way the file server will, then check it
        target = Path(self.translate_path(self.path)).resolve()
        rel = target.relative_to(ROOT).parts if target.is_relative_to(ROOT) else None
        if rel is None or (rel and rel[0] not in STATIC):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = -1
        if n < 0:
            return self._json({"error": "bad Content-Length"}, 400)
        if n > 40_000_000:
            return self._json({"error": "too large"}, 413)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._json({"error": "bad json"}, 400)
        if not isinstance(body, dict):
            return self._json({"error": "body must be a JSON object"}, 400)
        route = {"/api/generate": self._generate, "/api/repair": self._repair, "/api/receipt": self._receipt}.get(self.path)
        if not route:
            return self._json({"error": "unknown endpoint"}, 404)
        try:
            return route(body)
        except BadRequest as e:
            return self._json({"error": str(e)}, 400)

    def _generate(self, b):
        if not models_ready():
            return self._json({"error": "models not downloaded yet: run server/fetch_models.py"}, 503)
        mode = b.get("mode", "underpaint")
        if mode not in MODES:
            return self._json({"error": f"unknown mode {mode}"}, 400)
        plan = image_field(b, "plan").convert("L")
        w, h = plan.size
        if max(w, h) > MAX_SIDE or w % 8 or h % 8:
            return self._json({"error": "plan must be a multiple of 8 px and at most 768 px a side"}, 400)
        params = dict(prompt=str(b.get("prompt", ""))[:400], mode=mode, strength=num(b, "strength", 0.75),
                      control=num(b, "control", 1.0), seed=num(b, "seed", 11, int), steps=num(b, "steps", 25, int),
                      guidance=num(b, "guidance", 7.0), invert_depth=flag(b, "invert_depth"), fast=flag(b, "fast"))
        t0 = time.time()
        try:
            out = ENGINE.generate(plan, progress=lambda i, n: PROGRESS.update(step=i, of=n), **params)
        except Exception as e:  # surface to the page; the server stays up
            ENGINE.status = "idle"
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        secs = round(time.time() - t0, 1)
        stamp, d = new_run("s", params["seed"])
        plan.save(d / "plan.png")
        out.save(d / "out.png")
        meta = dict(params, width=w, height=h, seconds=secs, device=ENGINE.device, sd=SD,
                    controlnet=CN_TILE if MODES[params["mode"]]["cn"] == "tile" else CN_DEPTH,
                    plan_steps=b.get("plan_steps"), plan_centers=b.get("plan_centers"))
        (d / "params.json").write_text(json.dumps(meta, indent=2))
        return self._json({"image": png_url(out), "run": stamp, "seconds": secs})

    def _repair(self, b):
        if not models_ready():
            return self._json({"error": "models not downloaded yet: run server/fetch_models.py"}, 503)
        img, mask = image_field(b, "image").convert("RGB"), image_field(b, "mask").convert("L")
        if img.size != mask.size or max(img.size) > MAX_SIDE or img.width % 8 or img.height % 8:
            return self._json({"error": "image and mask must match, multiples of 8 px, at most 768 px a side"}, 400)
        params = dict(prompt=str(b.get("prompt", ""))[:400], strength=num(b, "strength", 0.6),
                      control=num(b, "control", 0.8), seed=num(b, "seed", 11, int), steps=num(b, "steps", 25, int),
                      guidance=num(b, "guidance", 7.0), fast=flag(b, "fast"))
        t0 = time.time()
        try:
            out = ENGINE.repair(img, mask, progress=lambda i, n: PROGRESS.update(step=i, of=n), **params)
        except Exception as e:
            ENGINE.status = "idle"
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        secs = round(time.time() - t0, 1)
        stamp, d = new_run("r", params["seed"])
        if b.get("plan"):
            image_field(b, "plan").convert("L").save(d / "plan.png")
        img.save(d / "corrected.png")
        mask.save(d / "mask.png")
        out.save(d / "out.png")
        meta = dict(params, kind="repair", parent=b.get("parent"), target=b.get("target"), width=img.width,
                    height=img.height, seconds=secs, device=ENGINE.device, sd=SD, controlnet=CN_TILE,
                    plan_steps=b.get("plan_steps"), plan_centers=b.get("plan_centers"))
        (d / "params.json").write_text(json.dumps(meta, indent=2))
        return self._json({"image": png_url(out), "run": stamp, "seconds": secs})

    def _receipt(self, b):
        run = str(b.get("run", ""))
        if not RUN_RE.fullmatch(run) or not (RUNS / run).is_dir():
            return self._json({"error": "unknown run"}, 404)
        (RUNS / run / "receipt.json").write_text(json.dumps(b.get("receipt"), indent=2))
        return self._json({"saved": f"runs/{run}/receipt.json"})


RUN_RE = re.compile(r"[0-9]{8}-[0-9]{6}(-[0-9]{3})?_[sr]-?[0-9]+")


def new_run(kind, seed):
    """A fresh run folder: stamp to the millisecond so two runs never share one."""
    t = time.time()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(t)) + f"-{int(t * 1000) % 1000:03d}_{kind}{int(seed)}"
    d = RUNS / stamp
    d.mkdir(parents=True, exist_ok=False)
    return stamp, d


if __name__ == "__main__":
    RUNS.mkdir(exist_ok=True)
    print(f"Grisaille on http://localhost:{PORT}  (models ready: {models_ready()})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
