# Example runs

Two pictures and a repair of each, from 13 Nov 2026, saved exactly as the app writes them (`plan.png`, `out.png`,
`params.json`, `receipt.json`; repairs add `corrected.png` and `mask.png`). All on one hand-drawn
three-value plan, prompt "a still life painting of a jug on a table by a window, oil on canvas".

| run | what it is | pattern held |
|---|---|---|
| `20261113-064047_s11` | "As depth", seed 11: values merged, 5 of 9 shapes lost | 17% |
| `20261113-070730-641_r11` | lost-shapes repair of that picture, with the 75% contrast floor (this early run's `params.json` does not name its parent; `receipt.json` gives the parent's 17%) | 95% |
| `20261113-083638-588_s11` | Underpaint, seed 11, over a plan with two dark bars | 93% |
| `20261113-083704-223_r11` | plan change: one bar moved, repainted at the shipped settings (24 px edge, repaint 0.9, hold 0.8); read against the new plan | 91% → 93% |
