// node tests/replan.test.js — plan changes: only the changed pixels move, and the picture then holds the new plan.
import { newPlan, stroke, STANDARD, restep } from '../js/plan.js';
import { readAgainst } from '../js/receipt.js';
import { planChangeMask, correctValues, labToRgb, repairTargets, MIN_CONTRAST } from '../js/repair.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const W = 96, H = 96;
const A = newPlan(W, H, 3);
for (let y = 20; y < 76; y++) for (let x = 16; x < 64; x++) A.level[y * W + x] = 1;
stroke(A, 30, 48, 30, 48, 10, 0);                       // dark disc on the left
const pic = new Uint8ClampedArray(W * H * 4);            // a picture that holds plan A, with colour
for (let i = 0; i < W * H; i++) {
    const [r, g, b] = labToRgb(STANDARD[3][A.level[i]], 15, 10);
    pic[i * 4] = r; pic[i * 4 + 1] = g; pic[i * 4 + 2] = b; pic[i * 4 + 3] = 255;
}
const RA = readAgainst(A, pic);
ok(RA.heldPattern > 0.95, `picture holds its own plan ${RA.heldPattern}`);

// plan B: the disc moved right (old place back to the mid value)
const B = { ...A, level: A.level.slice() };
stroke(B, 30, 48, 30, 48, 10, 1);
stroke(B, 70, 48, 70, 48, 10, 0);
const none = planChangeMask(A, { ...A, level: A.level.slice() });
ok(none.ok && none.changed === 0 && none.frac === 0, 'unchanged plan: empty mask');
const ch = planChangeMask(A, B);
ok(ch.ok && ch.changed > 0.03 && ch.changed < 0.15, `changed share ${ch.changed.toFixed(3)}`);
ok(ch.frac > ch.changed, `mask widened ${ch.frac.toFixed(3)} > ${ch.changed.toFixed(3)}`);
let coreOutside = 0; for (let i = 0; i < W * H; i++) if (ch.core[i] && !ch.mask[i]) coreOutside++;
ok(coreOutside === 0, 'core lies inside the mask');

const before = readAgainst(B, pic);
const fixed = correctValues(pic, B, RA, ch.core);
let moved = 0; for (let i = 0; i < W * H; i++) if (!ch.core[i] && fixed[i * 4] !== pic[i * 4]) moved++;
ok(moved === 0, `only changed pixels move (${moved} others did)`);
const after = readAgainst(B, fixed);
ok(after.heldPattern > before.heldPattern + 0.03, `new plan held ${before.heldPattern} -> ${after.heldPattern}`);
ok(after.lostShapes === 0, `no lost shapes after (${after.lostShapes}, before ${before.lostShapes})`);

ok(!planChangeMask(A, restep(A, 5)).ok, 'value count change refused');
ok(!planChangeMask(A, newPlan(96, 64, 3)).ok, 'frame change refused');
ok(!planChangeMask(A, { ...B, centers: [20, 50, 85] }).ok, 'changed value centres refused');

// the contrast floor centres on the plan the picture was fitted against, not the edited one
const flat = { ...RA, contrast: 0.3 };
const allDark = { ...A, level: new Uint8Array(W * H) };          // an edit that makes the plan's mean much darker
const t1 = repairTargets(A, flat), t2 = repairTargets(allDark, flat);
ok(t1.every((v, k) => Math.abs(v - t2[k]) < 1e-9), `floor targets do not move with the edited plan's mean ${t1} vs ${t2}`);
ok(Math.abs((t1[2] - t1[0]) - MIN_CONTRAST * (A.centers[2] - A.centers[0])) < 1e-9, 'floor restores 75% of the range');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
