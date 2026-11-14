// node tests/receipt.test.js — checks the receipt against pictures whose answer is known.
import { newPlan, planToRGBA, fillAt, stroke, planFromImage, restep, STANDARD } from '../js/plan.js';
import { readAgainst, summary, planShapes, receiptRecord } from '../js/receipt.js';
import { lToByte } from '../js/squint.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

const W = 96, H = 96;
// three-value plan: light ground, a mid block, a dark disc inside it
function testPlan() {
    const p = newPlan(W, H, 3);
    for (let y = 20; y < 76; y++) for (let x = 16; x < 64; x++) p.level[y * W + x] = 1;
    stroke(p, 40, 48, 40, 48, 12, 0);
    return p;
}
// paint a picture from the plan with a function of L*
function paint(p, f) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const g = lToByte(f(p.centers[p.level[i]], i));
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

const P = testPlan();

// 1. the plan read against itself holds everywhere (allowing the squint's edge softening)
let R = readAgainst(P, planToRGBA(P));
ok(R.heldPattern > 0.97, `self pattern ${R.heldPattern}`);
ok(R.heldExact > 0.97, `self exact ${R.heldExact}`);
ok(Math.abs(R.keyShift) < 1, `self key shift ${R.keyShift}`);
ok(R.pairs.every(q => q.state === 'apart'), 'self pairs apart');
ok(R.lostShapes === 0, 'self no lost shapes');

// 2. the same pattern 25 L* lighter: pattern holds, exact does not, key shift is reported
R = readAgainst(P, paint(P, L => Math.min(100, L + 25)));
ok(R.heldPattern > 0.97, `lighter pattern ${R.heldPattern}`);
ok(R.heldExact < 0.75, `lighter exact ${R.heldExact}`);
ok(R.keyShift > 15, `lighter key shift ${R.keyShift}`);

// 3. dark and mid painted the same: merged, and the dark disc is lost
R = readAgainst(P, paint(P, L => (L < 60 ? 40 : L)));
ok(R.pairs.find(q => q.lo === 0).state === 'merged', 'merge detected');
ok(R.pairs.find(q => q.lo === 1).state === 'apart', 'mid/light still apart');

// 4. values reversed: swapped
R = readAgainst(P, paint(P, L => 100 - L));
ok(R.pairs.every(q => q.state === 'swapped'), 'reversal reads as swapped');
ok(R.heldExact < 0.5, `reversed exact ${R.heldExact}`);

// 5. pure noise texture on top of the right values still holds after the squint
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
R = readAgainst(P, paint(P, L => L + (rnd() - 0.5) * 16));
ok(R.heldPattern > 0.9, `textured pattern ${R.heldPattern}`);

// 6. shapes: three (ground, block, disc), largest first; disc lost when painted as the block
const S = planShapes(P);
ok(S.length === 3 && S[0].k === 2 && S.some(s => s.k === 0), `shapes ${S.map(s => s.k)}`);
R = readAgainst(P, paint(P, L => (L < 30 ? STANDARD[3][1] : L)));
ok(R.shapes.find(s => s.k === 0).lost, 'painted-over disc is lost');
ok(R.lostShapes === 1, `one lost ${R.lostShapes}`);

// 7. a plan squinted from a picture of a plan returns that plan
const Q = planFromImage(planToRGBA(P), W, H, 3);
let same = 0; for (let i = 0; i < W * H; i++) if (Q.level[i] === P.level[i]) same++;
ok(same / (W * H) > 0.97, `planFromImage roundtrip ${same / (W * H)}`);
ok(Q.centers.every((c, k) => Math.abs(c - P.centers[k]) < 3), `centers ${Q.centers}`);

// 8. fill, restep and the saved record
const F = newPlan(W, H, 2); fillAt(F, 5, 5, 0); ok(F.level.every(v => v === 0), 'fill whole frame');
const F5 = restep(P, 5); ok(F5.steps === 5 && new Set(F5.level).size === 3, 'restep 3->5 keeps 3 shapes');
const rec = receiptRecord(readAgainst(P, planToRGBA(P)), { run: 'x' });
ok(!('maps' in rec) && rec.run === 'x' && JSON.stringify(rec).length < 20000, 'record is small, no maps');
ok(typeof summary(R) === 'string' && summary(R).includes('1 of 3 shapes lost'), summary(R));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
