// A value plan: W x H, `steps` values, one value index per pixel (0 = darkest), and the L* of each value.
import { lightness, squint, kmeans1d, absorbSmall, minRegion, lToByte } from './squint.js';

// Values a drawn plan starts with (CIE L*). 2 = notan: ink and paper.
export const STANDARD = { 2: [15, 90], 3: [15, 52, 88], 5: [12, 32, 52, 72, 92] };

export function newPlan(W, H, steps, fill = steps - 1) {
    return { W, H, steps, centers: STANDARD[steps].slice(), level: new Uint8Array(W * H).fill(fill), source: 'drawn' };
}

export const midsOf = centers => centers.slice(1).map((c, i) => (c + centers[i]) / 2);

export function stepOf(L, mids) { let k = 0; while (k < mids.length && L >= mids[k]) k++; return k; }

// Squint a picture into a plan, (L*, Kuwahara, 1-D k-means, small shapes absorbed).
export function planFromImage(rgba, W, H, steps, strength = 0.5) {
    const n = W * H;
    const L = squint(lightness(rgba, n), W, H, strength);
    const centers = kmeansBest(L, steps);
    const mids = midsOf(centers);
    const level = new Uint8Array(n);
    for (let i = 0; i < n; i++) level[i] = stepOf(L[i], mids);
    const floor = minRegion(n, steps, strength);
    absorbSmall(level, W, H, floor);
    absorbSmall(level, W, H, floor);
    return { W, H, steps, centers: centers.map(c => Math.round(c * 10) / 10), level, source: 'image' };
}

// The squint's 1-D k-means seeds at quantiles, so a frame that is mostly one value can put two
// centres on it (a flat plan read back as 46/86/88). Also run Lloyd's from centres spread evenly over
// the range, and keep whichever leaves less squared error.
export function kmeansBest(L, k) {
    const hist = new Float64Array(101);
    let lo = 100, hi = 0;
    for (let i = 0; i < L.length; i++) { const v = Math.max(0, Math.min(100, Math.round(L[i]))); hist[v]++; if (v < lo) lo = v; if (v > hi) hi = v; }
    const sse = c => { let e = 0; for (let v = 0; v <= 100; v++) if (hist[v]) e += hist[v] * Math.min(...c.map(q => (v - q) ** 2)); return e; };
    const a = kmeans1d(L, k);
    let b = Array.from({ length: k }, (_, j) => lo + (hi - lo) * (j + 0.5) / k);
    for (let it = 0; it < 40; it++) {
        const s = new Float64Array(k), w = new Float64Array(k);
        for (let v = 0; v <= 100; v++) {
            if (!hist[v]) continue;
            let j = 0, d = Infinity;
            for (let q = 0; q < k; q++) { const e = Math.abs(v - b[q]); if (e < d) { d = e; j = q; } }
            s[j] += v * hist[v]; w[j] += hist[v];
        }
        b = b.map((c, q) => (w[q] ? s[q] / w[q] : c)).sort((p, q) => p - q);
    }
    for (let q = 1; q < k; q++) if (b[q] - b[q - 1] < 2) b[q] = b[q - 1] + 2;
    return sse(b) < sse(a) ? b : a;
}

// Change the number of values of an existing plan, keeping its pattern as far as it goes.
export function restep(plan, steps) {
    if (steps === plan.steps) return plan;
    const target = STANDARD[steps], from = plan.centers;
    const level = plan.level.map(k => {
        let best = 0, d = Infinity;
        for (let j = 0; j < steps; j++) { const e = Math.abs(target[j] - from[k]); if (e < d) { d = e; best = j; } }
        return best;
    });
    return { ...plan, steps, centers: target.slice(), level };
}

// The plan drawn in its own values, as grey RGBA.
export function planToRGBA(plan, out = new Uint8ClampedArray(plan.W * plan.H * 4)) {
    const lut = plan.centers.map(lToByte);
    for (let i = 0; i < plan.level.length; i++) {
        const g = lut[plan.level[i]];
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255;
    }
    return out;
}

// Flood-fill the shape under (x, y) with value k.
export function fillAt(plan, x, y, k) {
    const { W, H, level } = plan, s = y * W + x, from = level[s];
    if (from === k) return;
    const stack = [s]; level[s] = k;
    while (stack.length) {
        const i = stack.pop(), px = i % W;
        for (const j of [px > 0 ? i - 1 : -1, px < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < W * (H - 1) ? i + W : -1])
            if (j >= 0 && level[j] === from) { level[j] = k; stack.push(j); }
    }
}

// A round dab of value k from (x0, y0) to (x1, y1).
export function stroke(plan, x0, y0, x1, y1, r, k) {
    const { W, H, level } = plan, len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(len / Math.max(1, r / 3)));
    for (let s = 0; s <= n; s++) {
        const cx = x0 + (x1 - x0) * s / n, cy = y0 + (y1 - y0) * s / n;
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
            for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++)
                if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) level[y * W + x] = k;
    }
}
