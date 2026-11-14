// Repair: put lost value shapes back, then let the generator repaint just those areas.
//
// 1. mask   : which pixels to repaint (the lost shapes, everything that drifted, or one chosen shape),
//             cleaned of speckle and widened a little so the generator has context at the edge.
// 2. correct: inside the mask, each pixel's lightness is moved by (its plan value as the picture's own
//             key and contrast put it, minus the picture's squinted lightness there). Colour (a*, b*)
//             and texture are kept; only the value is pushed back to the plan. The overall key of the
//             picture is not changed, so a repaired area joins the rest of the picture. The contrast is
//             raised to at least MIN_CONTRAST of the plan's range: a picture whose values collapsed would
//             otherwise be "repaired" to values a few L* apart (seen 13 Nov: contrast 0.21).
// 3. the server repaints the masked area over the corrected picture (inpaint + tile ControlNet holding
//    the corrected picture) and composites it back, so nothing outside the mask moves.
import { boxBlur } from './squint.js';
import { planShapes } from './receipt.js';

export const MASK_GROW_PX = 6;      // context around the repaired area
export const DRIFT_CLEAN = 0.35;    // drift pixels must make up this share of a small neighbourhood
export const MIN_CONTRAST = 0.75;   // repair restores at least this share of the plan's value range
export const CHANGE_GROW_PX = 24;   // plan changes repaint a wider edge: an object cut by the change is repainted whole (13 Nov sweep)
export const CHANGE_REPAINT = 0.9;  // and repaint harder, so a moved mass is painted, not pasted

export function repairMask(plan, R, target, shapeId = null) {
    const { W, H, level } = plan, n = W * H;
    let m = new Float32Array(n);
    if (target === 'drift') {
        const { pattern } = R.maps;
        for (let i = 0; i < n; i++) m[i] = pattern[i] !== level[i] ? 1 : 0;
        const b = boxBlur(m, W, H, 3);
        for (let i = 0; i < n; i++) m[i] = b[i] > DRIFT_CLEAN ? 1 : 0;
    } else {
        const want = new Set(target === 'shape' ? [shapeId] : R.shapes.filter(s => s.lost).map(s => s.id));
        for (const s of planShapes(plan)) if (want.has(s.id)) for (const i of s.px) m[i] = 1;
    }
    const g = boxBlur(m, W, H, MASK_GROW_PX);
    const mask = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) if (g[i] > 0.01) { mask[i] = 1; count++; }
    return { mask, frac: count / n };
}

// Plan changes: the pixels where the edited plan differs from the plan a picture was made over.
// core = the changed pixels (their values are corrected); mask = core widened (repainted, for context).
// Both plans must share frame and value count; the picture's own key/contrast fit is reused.
// The edge is wide (CHANGE_GROW_PX): at 6 px a moved dark cut the jug it had been part of in half.
export function planChangeMask(oldPlan, newPlan) {
    if (oldPlan.W !== newPlan.W || oldPlan.H !== newPlan.H) return { ok: false, reason: 'the frame changed' };
    if (oldPlan.steps !== newPlan.steps) return { ok: false, reason: 'the number of values changed' };
    // the picture's fit is indexed by value, so the values themselves must be the ones it was fitted to
    if (oldPlan.centers.some((c, k) => Math.abs(c - newPlan.centers[k]) > 0.5)) return { ok: false, reason: 'the plan\'s values changed (re-squinted)' };
    const { W, H } = newPlan, n = W * H, core = new Uint8Array(n), m = new Float32Array(n);
    let changed = 0;
    for (let i = 0; i < n; i++) if (oldPlan.level[i] !== newPlan.level[i]) { core[i] = 1; m[i] = 1; changed++; }
    const g = boxBlur(m, W, H, CHANGE_GROW_PX), mask = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) if (g[i] > 0.01) { mask[i] = 1; count++; }
    return { ok: true, core, mask, changed: changed / n, frac: count / n };
}

export function correctValues(rgba, plan, R, mask) {
    const out = new Uint8ClampedArray(rgba);
    const { L } = R.maps, target = repairTargets(plan, R);
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const d = target[plan.level[i]] - L[i];
        const [l, a, b] = rgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
        const [r, g, bl] = labToRgb(Math.max(0, Math.min(100, l + d)), a, b);
        out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = bl;
    }
    return out;
}

// The L* each plan value is repaired to: the picture's own key, contrast no lower than MIN_CONTRAST.
export function repairTargets(plan, R) {
    if (R.contrast >= MIN_CONTRAST) return R.fittedL.slice();
    // centre on the plan mean the picture was fitted against (R may come from an earlier plan)
    const c = plan.centers, planMean = R.planMean, key = R.meanL;
    return c.map(v => Math.max(0, Math.min(100, key + MIN_CONTRAST * (v - planMean))));
}

export function maskToRGBA(mask) {
    const out = new Uint8ClampedArray(mask.length * 4);
    for (let i = 0; i < mask.length; i++) { const v = mask[i] ? 255 : 0; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
    return out;
}

// sRGB (D65) <-> CIELAB
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gam = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = t => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
export function rgbToLab(r8, g8, b8) {
    const r = lin(r8), g = lin(g8), b = lin(b8);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b,
          Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089;
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const X = fi(fx) * 0.9505, Y = L > 8 ? fy ** 3 : L / 903.3, Z = fi(fz) * 1.089;
    const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, bl = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    return [r, g, bl].map(c => Math.round(Math.max(0, Math.min(255, gam(Math.max(0, c))))));
}
