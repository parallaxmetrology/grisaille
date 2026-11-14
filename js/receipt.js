// The receipt: read a picture against a value plan.
//
// The picture is squinted exactly as the plan was (the same squint), then every pixel is asked
// two questions:
//   exact   : does it fall in the plan's own value band (the plan's L* thresholds)?
//   pattern : the same question after one global adjustment: the plan's values are moved by a single
//             fitted key (offset) and contrast (scale, kept positive), L_pic ~ contrast * L_plan + key.
//             This forgives a picture that went lighter, darker, flatter or punchier overall (both are
//             reported) and asks only whether the plan's shapes kept their value relationships.
// Nothing here is a grade. Each number is a count of pixels or a difference in L*.
import { lightness, squint } from './squint.js';
import { midsOf, stepOf } from './plan.js';

export const MERGE_LSTAR = 3;          // neighbouring values closer than this in the picture read as one
export const SHAPE_MIN_FRAC = 0.005;   // shapes smaller than 0.5% of the frame are not listed
export const LOST_BELOW = 0.5;         // a shape is "lost" when under half of it holds its value

export function readAgainst(plan, rgba, opts = {}) {
    const { W, H, steps, centers, level } = plan, n = W * H;
    const L = squint(lightness(rgba, n), W, H, opts.squint ?? 0.5);
    const mids = midsOf(centers);

    // per plan value: area, picture mean and spread
    const area = new Float64Array(steps), sum = new Float64Array(steps), sq = new Float64Array(steps);
    let planMean = 0, outMean = 0;
    for (let i = 0; i < n; i++) {
        const k = level[i], v = L[i];
        area[k]++; sum[k] += v; sq[k] += v * v;
        planMean += centers[k]; outMean += v;
    }
    planMean /= n; outMean /= n;
    const means = Array.from(sum, (s, k) => area[k] ? s / area[k] : null);
    const sds = Array.from(sq, (s, k) => area[k] ? Math.sqrt(Math.max(0, s / area[k] - means[k] ** 2)) : null);

    // one global key + contrast fit, least squares over all pixels: L_pic ~ c * L_plan + b, c > 0
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const x = centers[level[i]] - planMean; sxx += x * x; sxy += x * (L[i] - outMean); }
    const contrast = Math.max(0.05, sxx > 0 ? sxy / sxx : 1);
    const fitted = centers.map(c => outMean + contrast * (c - planMean));
    const fmids = midsOf(fitted);

    // exact and pattern step per pixel
    const exact = new Uint8Array(n), pattern = new Uint8Array(n);
    let heldExact = 0, heldPattern = 0;
    const heldK = new Float64Array(steps);
    for (let i = 0; i < n; i++) {
        const v = L[i];
        exact[i] = stepOf(v, mids);
        pattern[i] = stepOf(v, fmids);
        if (exact[i] === level[i]) heldExact++;
        if (pattern[i] === level[i]) { heldPattern++; heldK[level[i]]++; }
    }

    // neighbouring values: kept apart, merged, or swapped
    const pairs = [];
    for (let k = 0; k + 1 < steps; k++) {
        if (means[k] === null || means[k + 1] === null) continue;
        const gap = means[k + 1] - means[k], planGap = centers[k + 1] - centers[k];
        pairs.push({ lo: k, hi: k + 1, planGap: r1(planGap), gap: r1(gap),
                     state: gap >= MERGE_LSTAR ? 'apart' : gap > -MERGE_LSTAR ? 'merged' : 'swapped' });
    }

    const shapes = planShapes(plan).map(s => {
        let held = 0, sumL = 0;
        for (const i of s.px) { if (pattern[i] === level[i]) held++; sumL += L[i]; }
        const { px, ...rest } = s;
        return { ...rest, held: r3(held / px.length), meanL: r1(sumL / px.length), lost: held / px.length < LOST_BELOW };
    });

    return {
        W, H, steps,
        heldPattern: r3(heldPattern / n), heldExact: r3(heldExact / n), keyShift: r1(outMean - planMean),
        meanL: outMean, planMean,   // the picture's and the plan's mean L*, unrounded (repair centres on them)
        contrast: r3(contrast), fittedL: fitted.map(r1),
        values: Array.from({ length: steps }, (_, k) => ({
            k, planL: centers[k], area: r3(area[k] / n), meanL: means[k] === null ? null : r1(means[k]),
            sd: sds[k] === null ? null : r1(sds[k]), held: area[k] ? r3(heldK[k] / area[k]) : null,
        })),
        pairs, shapes,
        lostShapes: shapes.filter(s => s.lost).length,
        maps: { L, exact, pattern },
    };
}

// The receipt without its per-pixel maps, for saving.
export function receiptRecord(R, extra = {}) {
    const { maps, ...rest } = R;
    return { ...extra, ...rest, rules: { merge_lstar: MERGE_LSTAR, shape_min_frac: SHAPE_MIN_FRAC, lost_below: LOST_BELOW } };
}

// One plain line from the numbers, no judgement.
export function summary(R) {
    const parts = [`Pattern held on ${pct(R.heldPattern)} of the picture`, `exact values on ${pct(R.heldExact)}`];
    if (Math.abs(R.keyShift) >= 2) parts.push(`${R.keyShift > 0 ? 'lighter' : 'darker'} overall by ${Math.abs(R.keyShift)} L*`);
    if (Math.abs(R.contrast - 1) >= 0.1) parts.push(`value range ${R.contrast < 1 ? 'compressed' : 'stretched'} to ${Math.round(R.contrast * 100)}% of the plan's`);
    const merged = R.pairs.filter(p => p.state === 'merged'), swapped = R.pairs.filter(p => p.state === 'swapped');
    if (merged.length) parts.push(merged.map(p => `values ${p.lo + 1} and ${p.hi + 1} merged`).join(', '));
    if (swapped.length) parts.push(swapped.map(p => `values ${p.lo + 1} and ${p.hi + 1} swapped`).join(', '));
    if (R.shapes.length) parts.push(`${R.lostShapes} of ${R.shapes.length} shapes lost`);
    return parts.map(p => p[0].toUpperCase() + p.slice(1)).join('. ') + '.';
}

// Connected shapes of the plan (4-connected, one value each), largest first.
export function planShapes(plan) {
    const { W, H, level } = plan, n = W * H, seen = new Uint8Array(n), out = [];
    const minPx = Math.max(16, Math.round(n * SHAPE_MIN_FRAC));
    for (let s = 0; s < n; s++) {
        if (seen[s]) continue;
        const k = level[s], px = [s], stack = [s]; seen[s] = 1;
        let x0 = W, y0 = H, x1 = 0, y1 = 0, sx = 0, sy = 0;
        while (stack.length) {
            const i = stack.pop(), x = i % W, y = (i - x) / W;
            sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < n - W ? i + W : -1])
                if (j >= 0 && !seen[j] && level[j] === k) { seen[j] = 1; stack.push(j); px.push(j); }
        }
        if (px.length >= minPx) out.push({ k, px, area: r3(px.length / n), cx: Math.round(sx / px.length), cy: Math.round(sy / px.length), box: [x0, y0, x1, y1] });
    }
    out.sort((a, b) => b.px.length - a.px.length);
    return out.map((s, i) => ({ id: i + 1, ...s }));
}

const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
const pct = v => `${Math.round(v * 100)}%`;
