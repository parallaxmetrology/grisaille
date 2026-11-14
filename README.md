# Grisaille

Plan the values. Generate over them. Read what held.

A painter blocks in a value plan (2, 3 or 5 values: notan, three-value or five-value), Stable
Diffusion 1.5 + ControlNet paints over it on your own machine, and the tool reads the picture back against
the plan: which shapes kept their value, which went lighter or darker, which neighbouring values
merged or swapped. Named for the grey underpainting that colour is laid over.

Built November 2026. Runs locally: a small Python server drives the generator, and everything
else (drawing, squint, receipt, repair masks) runs in the browser.

## Run it

Needs Python 3.12, Node (for the tests only) and a GPU: Apple Silicon (MPS) or CUDA. Built and
tested on an M1 Max with 32 GB.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server/fetch_models.py     # one time, about 6 GB, into HF_HOME
.venv/bin/python server/serve.py            # then open http://localhost:7569
```

- **First generation** loads the models (about 1 to 1.5 minutes). After that each picture takes
  about 20 to 40 s on an M1 Max.
- **Models** go to `HF_HOME` (default `~/.cache/huggingface`); set it to keep them on another
  drive. Reading pictures against a plan works without the server.
- **Tests:** `node tests/receipt.test.js`, `node tests/repair.test.js`, `node tests/replan.test.js`,
  on pictures whose answer is known.

## Using it

1. **Value plan.** Draw with Brush/Fill and the value swatches (keys 1–5, B, F, Cmd-Z), or drop a
   picture onto the plan to squint it into values. The Squint slider sets how hard it squints.
2. **Generate over it.** Three ways to hand the plan to the generator:

   | mode | what happens | defaults |
   |---|---|---|
   | **Underpaint** | img2img from the plan, plus ControlNet tile holding it | Repaint 0.95, Hold 0.45 |
   | **Tile** | from noise, ControlNet tile only | Hold 0.6 |
   | **As depth** | the plan handed over as if it were depth (darks = near) | Hold 1.0 |

   **Variants are ranked by the receipt.** Generate 1–8 (default 4, consecutive seeds); the strip is
   sorted by pattern held, best first, and the best of the batch opens. The note gives the range.
3. **Picture.** Picture / Squinted / Held map / Plan. The held map colours each pixel by how many
   value steps it moved from the plan (blue darker, amber/red lighter, grey held). You can also read
   **your own painting** against the plan ("Read my own picture…"): photograph the canvas and check it
   against the thumbnail you planned it from.
4. **Receipt.** Pattern held, exact values held, key shift, value range, a per-value table, pairs
   (apart / merged / swapped) and shapes (lost when under half holds). Saved per run.
5. **Repair.** Choose Lost shapes, Everything that drifted, or a shape you clicked in the list.
   Grisaille (a) builds a mask of those areas, cleaned of speckle and widened by 6 px; (b) inside it,
   moves each pixel's lightness back to its plan value *as the picture's own key and contrast put it*,
   keeping colour (a*, b*) and texture; (c) repaints only the mask with Stable Diffusion inpainting
   held by ControlNet tile to that corrected picture (Repaint 0.6, Hold 0.8), and composites it back,
   so nothing outside the mask moves (the softened edge is kept inside the mask). If the
   picture's values had collapsed (value range under 75% of the plan's), the correction restores at least 75% of the plan's range rather than the picture's
   own. The repair gets its own receipt with a before/after line, and its run folder keeps
   `corrected.png` and `mask.png` and names its parent run.
6. **Plan changes.** With a picture selected, edit the plan in card 1: move a dark, widen a band,
   merge two values. The repair box switches to *Plan changes* and says how much of the plan you
   changed. Grisaille (a) takes the pixels where the new plan differs from the picture's plan;
   (b) moves only those pixels' lightness to the new plan (the picture's own key and contrast, as in
   repair); (c) repaints them plus a 24 px edge (Repaint 0.9, Hold 0.8), so an object the change cut
   through is repainted whole. The result is labelled *re-plan*, holds the new plan, and its receipt
   reads the picture against the new plan before and after. Frame and value count must stay the same.

## What the first runs showed (13 Nov, one hand-drawn three-value plan)

| run | pattern held | what the receipt said |
|---|---|---|
| Underpaint, seed 11 | 97% | darks lifted from L* 15 to 26, all values kept apart, no shapes lost |
| Underpaint, seed 12 | 93% | the same lift (15 to 25); the held map shows the jug's white belly painted lighter than its plan value |
| As depth, seed 11 | 17% | values 1 and 2 merged (L* 42 and 45), the light value fell to 54, 5 of 9 shapes lost |

From the settings sweep (scratch, not saved): Underpaint at Repaint 0.75 and Hold 1.0 only
reproduces the flat plan; Repaint 0.9–1.0 with Hold 0.4–0.6 paints a picture over it that keeps the
shapes. "As depth" invents freely and can swap values (a dark disc became a light sphere). That fits
the earlier finding that a depth map only nudges ControlNet. These are a few pictures, not a study.

## How the receipt reads

The picture is squinted exactly as the plan was (CIE L*, box blur, two Kuwahara passes).
**Exact**: each pixel falls in the plan's own value band. **Pattern**: the same after one global
least-squares fit `L_picture ≈ contrast × L_plan + key` (contrast kept positive), so a picture that
went lighter, darker or flatter overall can still hold the pattern; key shift and contrast are
reported. Neighbouring values closer than 3 L* in the picture are **merged**, reversed ones
**swapped**. Plan shapes are 4-connected regions of one value, at least 0.5% of the frame. A shape
is **lost** when under half of it holds. Counts and L* differences, not grades.

## Files

| path | what |
|---|---|
| `index.html`, `css/app.css`, `js/app.js` | the page |
| `examples/` | two saved pictures and a repair of each (see its README) |
| `js/plan.js` | the plan: drawing, squinting a picture into values, changing value count |
| `js/receipt.js` | the receipt |
| `js/repair.js` | repair mask and value correction |
| `js/squint.js` | the squint: L*, box blur, Kuwahara, 1-D k-means, small shapes absorbed |
| `server/serve.py` | local server: static files, `/api/generate`, `/api/repair`, `/api/receipt`, `/api/status` |
| `server/models.py` | model ids, the three modes, the pipeline (MPS, fp16, UniPC, 25 steps, CFG 7) |
| `server/fetch_models.py` | one-time model download |
| `runs/<stamp>_s<seed>/` | every generation (created as you work): `plan.png`, `out.png`, `params.json`, `receipt.json` |
| `runs/<stamp>_r<seed>/` | every repair: the same plus `corrected.png`, `mask.png`; `params.json` names the parent run |
| `tests/receipt.test.js` | receipt and plan checks |
| `tests/repair.test.js` | repair: value correction restores a lost shape, keeps its colour, touches nothing outside the mask, floors collapsed contrast |
| `tests/replan.test.js` | plan changes: only changed pixels move, the picture then holds the new plan, frame or value-count changes refused |

## Built on

- Stable Diffusion 1.5 (`stable-diffusion-v1-5/stable-diffusion-v1-5`, CreativeML OpenRAIL-M) and
  ControlNet 1.1 tile and depth (`lllyasviel/control_v11f1e_sd15_tile`, `control_v11f1p_sd15_depth`),
  run with Hugging Face diffusers. The models are downloaded separately and keep their own licences.
- Zhang, Rao and Agrawala, *Adding Conditional Control to Text-to-Image Diffusion Models* (ControlNet,
  arXiv 2302.05543), and the ControlNet 1.1 release. Reading the drag-editing papers (DragGAN,
  DragDiffusion, DragonDiffusion) led to the plan-changes step, which uses inpainting, not their methods.
- Why tone and not depth: in an earlier experiment by the author, a picture's own tone handed to
  ControlNet anchored generation better than depth maps did.

## What repair did on the first tries (13 Nov)

| picture | target | pattern held | lost shapes | value range | what it looks like |
|---|---|---|---|---|---|
| "As depth", seed 11 | lost shapes (92% of frame) | 17% → 91% | 5 → 0 | 21% → 26% | bars barely darker than the ground: led to the 75% floor |
| same, with the 75% floor | lost shapes | 17% → 95% | 5 → 0 | 21% → 49% | bars and bands clearly back, not to the plan's full range |
| Underpaint, seed 12 | everything that drifted (14%) | 93% → 98% | 0 → 0 | 89% → 93% | plan's two dark bars painted into the jug: the numbers improved, the picture got worse |

Pixels outside the softened mask were checked against the original: maximum difference 0. Measured
again on 13 Nov against the hard mask: the 3 px blur reached about 8 px past it (up to 21/255 at the
border, 0 beyond 8 px). The softening is now kept inside the mask; rechecked on a plan-change
repaint: 229,201 pixels outside the mask, maximum difference 0.

Reading: **Lost shapes** and **a chosen shape** are the useful repairs: they put back what the plan
needs. **Everything that drifted** enforces the plan literally, including where the generator's
reading (one jug for two bars) was better than the plan. The receipt measures fidelity to the plan,
not quality.

## What plan changes did on the first tries (13 Nov)

One dark bar of a three-value plan moved sideways (4% of the plan changed), on underpaint pictures,
seed 11. Scored against the new plan.

| edge, repaint, hold | pattern held, before → after | what it looks like |
|---|---|---|
| 6 px, 0.6, 0.8 (repair defaults) | 93% → 97% | old place lightened through the jug, leaving a seam; a flat dark bar pasted at the new place |
| 6 px, 0.8–0.95, 0.8 | 97% | seam stays; the new dark painted as a dark object with a hard outline |
| 6 or 24 px, 0.95–1.0, 0.3–0.4 | 94–95% (one shape lost at 0.3) | the new dark breaks into blue and yellow streaks |
| 24 px, 0.8–0.95, 0.8 | 96% | jug repainted whole, no seam; the new dark is a dark object with a shadow |
| 24 px, 0.9, 0.8 (shipped), second picture | 91% → 93% | a dark post painted behind the teapot, with shadow; the rest unchanged. The one shape still lost is the other dark bar, already lost (25% held) before the change; it was not edited, so it was not repainted (Lost shapes repair is the tool for it) |

The 6 px repair edge cut the jug because the moved bar had been part of it. The wider edge costs about
one point of pattern held and keeps the picture whole. Generating from scratch over the edited plan
remains the other route when much of the plan changes (the page suggests it above 40%).

## Fast mode (tested, not shipped)

LCM-LoRA (`latent-consistency/lcm-lora-sdv1-5`, 130 MB) was tested on 13 Nov against
normal mode: the same plan, seeds 11–14, both Underpaint and Tile, scored by the receipt.

| | seconds | pattern held | how it looks |
|---|---|---|---|
| Underpaint, normal | about 24 | 93–97% | painted: light, window, table, colour |
| Underpaint, fast (6 steps, CFG 1.5) | about 6 | 98% | the flat plan with a jug pasted in |
| Tile, normal | about 26 | 90–96% | painted |
| Tile, fast | about 7 | 98% | the flat plan with a jug pasted in |
| Underpaint, fast, Hold 0.3 / 0.2, 8 steps | about 9 | 22–96%, mostly 50–70% | painted, but flat poster colour and the plan lost |

Fast held the plan more only because it painted less, and loosening it lost the plan. The bar was
"only if it loses nothing", so the page does not offer it. The server still accepts `fast: true`
on both endpoints (`server/models.py`, `FAST_STEPS`, `FAST_GUIDANCE`) if it is worth revisiting.

## Known limits

- SD 1.5 at 512–768 px. Prompts steer subject and colour; the plan steers values and shapes.
- The tile ControlNet ships only as a `.bin` (pickle) file from lllyasviel's official repo; diffusers
  loads it with a warning.
- One job at a time. A second open copy of the page generates too: each Generate click in each copy
  is its own run.

## Citing

See [CITATION.cff](CITATION.cff), or use GitHub's "Cite this repository" button.

## Licence

Code: MIT (see [LICENSE](LICENSE)). README and example images: CC BY 4.0 (see
[LICENSE-CONTENT](LICENSE-CONTENT)). The models it downloads are not part of this repository and are
used under their own licences, including the use restrictions of CreativeML OpenRAIL-M.
