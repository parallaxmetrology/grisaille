// The painter's squint: perceptual lightness (CIE L*), a box blur, two Kuwahara (edge-preserving)
// passes, then 1-D k-means into value steps with small shapes absorbed into their neighbours.
// These helpers come from an earlier squint viewer by the same author.

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

// CIE L* (0..100) per pixel of an RGBA buffer.
export function lightness(rgba, n) {
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const Y = 0.2126 * LIN[rgba[i * 4]] + 0.7152 * LIN[rgba[i * 4 + 1]] + 0.0722 * LIN[rgba[i * 4 + 2]];
        L[i] = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
    }
    return L;
}

// L* -> sRGB byte (for drawing a plan in its own values)
export function lToByte(L) {
    const l = Math.max(0, Math.min(100, L));
    const Y = l > 8 ? ((l + 16) / 116) ** 3 : l / 903.3;
    const s = Y <= 0.0031308 ? 12.92 * Y : 1.055 * Y ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, s)) * 255);
}

// The squint: denoise, then two edge-preserving flattening passes.
export function squint(L, W, H, strength = 0.5) {
    L = boxBlur(L, W, H, 1);
    const kr = Math.max(1, Math.round(Math.max(W, H) / 64 * (0.4 + 1.6 * strength)));
    L = kuwahara(L, W, H, kr);
    return kuwahara(L, W, H, Math.max(1, kr - 1));
}

// The small-shape floor for a given frame and squint
export function minRegion(n, steps, strength = 0.5) {
    return Math.max(4, Math.round(n * (steps >= 5 ? 0.0012 : 0.002) * (0.25 + 3 * strength * strength)));
}

export function kuwahara(src, W, H, r) {
    const W1 = W + 1;
    const S = new Float64Array(W1 * (H + 1)), Q = new Float64Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
        let rs = 0, rq = 0;
        for (let x = 0; x < W; x++) {
            const v = src[y * W + x]; rs += v; rq += v * v;
            S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs;
            Q[(y + 1) * W1 + x + 1] = Q[y * W1 + x + 1] + rq;
        }
    }
    const box = (T, x0, y0, x1, y1) => T[y1 * W1 + x1] - T[y0 * W1 + x1] - T[y1 * W1 + x0] + T[y0 * W1 + x0];
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let best = Infinity, mean = src[y * W + x];
        for (let q = 0; q < 4; q++) {
            const x0 = q & 1 ? x : Math.max(0, x - r), x1 = q & 1 ? Math.min(W, x + r + 1) : x + 1;
            const y0 = q & 2 ? y : Math.max(0, y - r), y1 = q & 2 ? Math.min(H, y + r + 1) : y + 1;
            const c = (x1 - x0) * (y1 - y0);
            const s = box(S, x0, y0, x1, y1), sq = box(Q, x0, y0, x1, y1);
            const m = s / c, v = sq / c - m * m;
            if (v < best) { best = v; mean = m; }
        }
        out[y * W + x] = mean;
    }
    return out;
}

// 1-D k-means on a 0..100 lightness histogram, seeded at quantiles.
export function kmeans1d(L, k) {
    const hist = new Float64Array(101);
    for (let i = 0; i < L.length; i++) hist[Math.max(0, Math.min(100, Math.round(L[i])))]++;
    const total = L.length;
    const c = [];
    let acc = 0, b = 0;
    for (let j = 0; j < k; j++) {
        const target = total * (j + 0.5) / k;
        while (b < 100 && acc + hist[b] < target) acc += hist[b++];
        c.push(b);
    }
    for (let it = 0; it < 25; it++) {
        const s = new Float64Array(k), w = new Float64Array(k);
        for (let v = 0; v <= 100; v++) {
            if (!hist[v]) continue;
            let j = 0, d = Infinity;
            for (let q = 0; q < k; q++) { const e = Math.abs(v - c[q]); if (e < d) { d = e; j = q; } }
            s[j] += v * hist[v]; w[j] += hist[v];
        }
        for (let q = 0; q < k; q++) if (w[q]) c[q] = s[q] / w[q];
        c.sort((p, q) => p - q);
    }
    for (let q = 1; q < k; q++) if (c[q] - c[q - 1] < 2) c[q] = c[q - 1] + 2;
    return c;
}

// Shapes smaller than minPx take the step most common along their edge.
export function absorbSmall(level, W, H, minPx) {
    const n = W * H;
    const seen = new Uint8Array(n), stack = new Int32Array(n), members = new Int32Array(n);
    for (let s = 0; s < n; s++) {
        if (seen[s]) continue;
        const lv = level[s];
        let sp = 0, m = 0;
        stack[sp++] = s; seen[s] = 1;
        const votes = new Map();
        while (sp) {
            const i = stack[--sp]; members[m++] = i;
            const x = i % W;
            const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < n - W ? i + W : -1];
            for (const j of nb) {
                if (j < 0) continue;
                if (level[j] === lv) { if (!seen[j]) { seen[j] = 1; stack[sp++] = j; } }
                else votes.set(level[j], (votes.get(level[j]) || 0) + 1);
            }
        }
        if (m < minPx && votes.size) {
            let to = lv, best = -1;
            for (const [k, v] of votes) if (v > best) { best = v; to = k; }
            for (let q = 0; q < m; q++) level[members[q]] = to;
        }
    }
}


export function boxBlur(src, W, H, r) {
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    const d = 2 * r + 1;
    for (let y = 0; y < H; y++) {
        let acc = 0; const row = y * W;
        for (let k = -r; k <= r; k++) acc += src[row + Math.min(W - 1, Math.max(0, k))];
        for (let x = 0; x < W; x++) {
            tmp[row + x] = acc / d;
            acc += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
        }
    }
    for (let x = 0; x < W; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
        for (let y = 0; y < H; y++) {
            out[y * W + x] = acc / d;
            acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
        }
    }
    return out;
}
