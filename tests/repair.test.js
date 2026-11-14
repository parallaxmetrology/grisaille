// node tests/repair.test.js — the value correction alone must restore what the receipt calls lost.
import { newPlan, stroke, STANDARD, planToRGBA } from '../js/plan.js';
import { readAgainst } from '../js/receipt.js';
import { repairMask, correctValues, rgbToLab, labToRgb, repairTargets, MIN_CONTRAST } from '../js/repair.js';
import { lToByte } from '../js/squint.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const W = 96, H = 96;
const P = newPlan(W, H, 3);
for (let y = 20; y < 76; y++) for (let x = 16; x < 64; x++) P.level[y * W + x] = 1;
stroke(P, 40, 48, 40, 48, 12, 0);
// a coloured picture of the plan in which the dark disc was painted at the mid value, warm red
const pic = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
    const k = P.level[i] === 0 ? 1 : P.level[i];
    const [r, g, b] = labToRgb(STANDARD[3][k], k === 1 ? 30 : 0, k === 1 ? 20 : 0);
    pic[i * 4] = r; pic[i * 4 + 1] = g; pic[i * 4 + 2] = b; pic[i * 4 + 3] = 255;
}
const R0 = readAgainst(P, pic);
ok(R0.lostShapes === 1, `one lost before ${R0.lostShapes}`);

// round trip of the colour conversion
for (const c of [[10, 20, 30], [200, 50, 90], [255, 255, 255], [0, 0, 0], [128, 128, 128]]) {
    const back = labToRgb(...rgbToLab(...c));
    ok(back.every((v, j) => Math.abs(v - c[j]) <= 1), `lab round trip ${c} -> ${back}`);
}

for (const target of ['lost', 'drift']) {
    const { mask, frac } = repairMask(P, R0, target);
    ok(frac > 0.03 && frac < 0.3, `${target} mask covers the disc and a margin: ${frac.toFixed(3)}`);
    let outside = 0; for (let i = 0; i < W * H; i++) if (!mask[i] && pic[i * 4] !== correctValues(pic, P, R0, mask)[i * 4]) outside++;
    ok(outside === 0, `${target}: nothing outside the mask changes`);
    const fixed = correctValues(pic, P, R0, mask);
    const R1 = readAgainst(P, fixed);
    ok(R1.lostShapes === 0, `${target}: no lost shapes after correction (${R1.lostShapes})`);
    ok(R1.heldPattern > R0.heldPattern + 0.03, `${target}: pattern ${R0.heldPattern} -> ${R1.heldPattern}`);
    // colour kept: the disc keeps its red hue (a* > 10)
    const i = 48 * W + 40, [, a] = rgbToLab(fixed[i * 4], fixed[i * 4 + 1], fixed[i * 4 + 2]);
    ok(a > 10, `${target}: disc keeps its colour, a* ${a.toFixed(1)}`);
}
const one = repairMask(P, R0, 'shape', R0.shapes.find(s => s.k === 0).id);
ok(one.frac > 0.03 && one.frac < 0.2, `single shape mask ${one.frac.toFixed(3)}`);
// a picture whose values collapsed (contrast ~0.2): the repair restores at least MIN_CONTRAST of the range
const flat = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { const g = lToByte(45 + 0.2 * (STANDARD[3][P.level[i]] - 52)); flat[i * 4] = flat[i * 4 + 1] = flat[i * 4 + 2] = g; flat[i * 4 + 3] = 255; }
const RF = readAgainst(P, flat);
ok(RF.contrast < 0.3, `collapsed picture reads as compressed ${RF.contrast}`);
const T = repairTargets(P, RF);
ok(Math.abs((T[2] - T[0]) / (STANDARD[3][2] - STANDARD[3][0]) - MIN_CONTRAST) < 0.01, `targets span ${MIN_CONTRAST} of the plan: ${T}`);
const all = new Uint8Array(W * H).fill(1);
const RF1 = readAgainst(P, correctValues(flat, P, RF, all));
ok(RF1.contrast > 0.7 && RF1.pairs.every(q => q.state === 'apart'), `collapsed picture repaired to contrast ${RF1.contrast}`);
const RN = readAgainst(P, planToRGBA(P));
ok(RN.contrast >= MIN_CONTRAST && JSON.stringify(repairTargets(P, RN)) === JSON.stringify(RN.fittedL), `normal-contrast picture keeps its own fit (${RN.contrast})`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
