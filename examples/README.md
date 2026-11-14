# Example runs

Two pictures and a repair of each, plus one from a photo, from 13–14 Nov 2026, saved exactly as the app writes them (`plan.png`, `out.png`,
`params.json`, `receipt.json`; repairs add `corrected.png` and `mask.png`). The first four are on hand-drawn
three-value plans (two), prompt "a still life painting of a jug on a table by a window, oil on canvas".

| run | what it is | pattern held |
|---|---|---|
| `20261113-064047_s11` | "As depth", seed 11: values merged, 5 of 9 shapes lost | 17% |
| `20261113-070730-641_r11` | lost-shapes repair of that picture, with the 75% contrast floor (this early run's `params.json` does not name its parent; `receipt.json` gives the parent's 17%) | 95% |
| `20261113-083638-588_s11` | Underpaint, seed 11, over a plan with two dark bars | 93% |
| `20261114-070141-111_r11` | plan change of that picture: the right-hand dark bar moved to the left, repainted at the shipped settings (24 px edge, repaint 0.9, hold 0.8); read against the new plan. A clean re-run (14 Nov) of the edit first tried on 13 Nov | 91% → 93% |
| `20261114-071232-902_s13` | a photo of sunflowers by the author (`source.jpg`, cropped to 512×640) squinted into three values, Tile mode, seed 13: best of four by the receipt (88–91%); prompt in `params.json` | 91% |
