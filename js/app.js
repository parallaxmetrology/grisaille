// Grisaille: draw or squint a value plan, generate over it on this Mac, read what held.
import { STANDARD, newPlan, planFromImage, restep, planToRGBA, fillAt, stroke } from './plan.js';
import { readAgainst, receiptRecord, summary } from './receipt.js';
import { lToByte } from './squint.js';
import { repairMask, planChangeMask, correctValues, maskToRGBA, CHANGE_REPAINT } from './repair.js';

const $ = id => document.getElementById(id);
const MODE_DEFAULTS = {
    underpaint: { strength: 0.95, control: 0.45, note: 'The plan is the underpainting: generation starts from it and the tile ControlNet holds it. Repaint near 1 lets the generator paint over it; Hold sets how hard the plan pulls.' },
    tile: { strength: 1, control: 0.6, note: 'Generation starts from noise and only the tile ControlNet pulls it toward the plan. Looser: expect invention.' },
    depth: { strength: 1, control: 1.0, note: 'The plan handed over as if it were depth (ControlNet depth). It steers shapes and space, not values: values can swap.' },
};
const S = {
    plan: null, tool: 'brush', value: 0, undo: [], source: null,   // source = {rgba, W, H} of a squinted picture
    mode: 'underpaint', results: [], sel: -1, view: 'pic', shape: null, busy: false, ready: false,
};

// ── persistence (per-viewer convenience only) ──
const KEY = 'grisaille.v1';
function savePlan() {
    try {
        const p = S.plan;
        let s = ''; for (let i = 0; i < p.level.length; i += 8192) s += String.fromCharCode(...p.level.subarray(i, i + 8192));
        const b = btoa(s);
        localStorage.setItem(KEY, JSON.stringify({ W: p.W, H: p.H, steps: p.steps, centers: p.centers, level: b, prompt: $('prompt').value }));
    } catch { /* storage unavailable: fine */ }
}
function loadPlan() {
    try {
        const o = JSON.parse(localStorage.getItem(KEY));
        if (!o) return null;
        const bin = atob(o.level), level = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) level[i] = bin.charCodeAt(i);
        if (o.prompt) $('prompt').value = o.prompt;
        return { W: o.W, H: o.H, steps: o.steps, centers: o.centers, level, source: 'saved' };
    } catch { return null; }
}

// ── plan canvas ──
const pc = $('plan'), pctx = pc.getContext('2d');
function setPlan(p, keepUndo) {
    if (!keepUndo && S.plan) pushUndo();
    S.plan = p;
    pc.width = p.W; pc.height = p.H;
    $('aspect').value = `${p.W}x${p.H}`;
    for (const b of $('steps').children) b.classList.toggle('on', +b.dataset.v === p.steps);
    if (S.value >= p.steps) S.value = 0;
    drawSwatches(); drawPlan();
}
function drawPlan() {
    const img = pctx.createImageData(S.plan.W, S.plan.H);
    planToRGBA(S.plan, img.data);
    pctx.putImageData(img, 0, 0);
    if (S.view === 'plan' || S.view === 'held') drawPic();
    savePlanSoon(); planEditedSoon();
}
let editT; const planEditedSoon = () => { clearTimeout(editT); editT = setTimeout(planEdited, 150); };
function planEdited() {
    const res = S.results[S.sel]; if (!res) return;
    const c = planChangeMask(res.plan, S.plan);
    if (c.ok && c.changed > 0 && $('repairTarget').value !== 'changes') { S.shape = null; $('repairTarget').value = 'changes'; repDefault(); }
    updateRepair();
}
let saveT; const savePlanSoon = () => { clearTimeout(saveT); saveT = setTimeout(savePlan, 400); };
function pushUndo() { S.undo.push({ ...S.plan, level: S.plan.level.slice(), centers: S.plan.centers.slice() }); if (S.undo.length > 30) S.undo.shift(); }
function drawSwatches() {
    const box = $('swatches'); box.innerHTML = '';
    S.plan.centers.forEach((L, k) => {
        const b = document.createElement('button'), g = lToByte(L);
        b.style.background = `rgb(${g},${g},${g})`; b.title = `Value ${k + 1} (L* ${Math.round(L)}) · key ${k + 1}`;
        b.innerHTML = `<span>${k + 1}</span>`; b.classList.toggle('on', k === S.value);
        b.onclick = () => { S.value = k; drawSwatches(); };
        box.appendChild(b);
    });
}
function planXY(e) {
    const r = pc.getBoundingClientRect();
    return [Math.floor((e.clientX - r.left) / r.width * S.plan.W), Math.floor((e.clientY - r.top) / r.height * S.plan.H)];
}
let last = null;
pc.addEventListener('pointerdown', e => {
    pc.setPointerCapture(e.pointerId);
    pushUndo();
    const [x, y] = planXY(e);
    if (S.tool === 'fill') { if (x >= 0 && y >= 0 && x < S.plan.W && y < S.plan.H) fillAt(S.plan, x, y, S.value); drawPlan(); return; }
    last = [x, y]; stroke(S.plan, x, y, x, y, brushR(), S.value); drawPlan();
});
pc.addEventListener('pointermove', e => {
    if (!last) return;
    const [x, y] = planXY(e);
    stroke(S.plan, last[0], last[1], x, y, brushR(), S.value); last = [x, y]; drawPlan();
});
for (const ev of ['pointerup', 'pointercancel']) pc.addEventListener(ev, () => { last = null; });
const brushR = () => +$('size').value / 2 * S.plan.W / 512;

seg('tool', v => { S.tool = v; });
seg('steps', v => {
    const n = +v;
    if (S.source && S.plan.source === 'image') setPlan(planFromImage(S.source.rgba, S.source.W, S.source.H, n, +$('squint').value));
    else setPlan(restep(S.plan, n));
});
$('aspect').onchange = () => {
    const [W, H] = $('aspect').value.split('x').map(Number);
    if (S.source) squintSource(S.source.img, W, H); else setPlan(newPlan(W, H, S.plan.steps));
};
$('clear').onclick = () => { S.source = null; $('squintRow').hidden = true; setPlan(newPlan(S.plan.W, S.plan.H, S.plan.steps)); };
$('undo').onclick = () => { const p = S.undo.pop(); if (p) setPlan(p, true); };
document.addEventListener('keydown', e => {
    if (e.target.matches('textarea, input')) return;
    if (e.key >= '1' && e.key <= '5' && +e.key <= S.plan.steps) { S.value = +e.key - 1; drawSwatches(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); $('undo').click(); }
    if (e.key === 'b') segSet('tool', 'brush'); if (e.key === 'f') segSet('tool', 'fill');
});

// ── squint a picture into a plan ──
function fitInto(img, W, H) {   // cover-crop the picture into W x H
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const s = Math.max(W / img.width, H / img.height), w = img.width * s, h = img.height * s;
    c.getContext('2d').drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    return c.getContext('2d').getImageData(0, 0, W, H).data;
}
function squintSource(img, W, H) {
    const rgba = fitInto(img, W, H);
    S.source = { img, rgba, W, H };
    setPlan(planFromImage(rgba, W, H, S.plan.steps, +$('squint').value));
    $('squintRow').hidden = false;
    $('planNote').textContent = `values L* ${S.plan.centers.map(Math.round).join(' / ')}`;
}
function bestAspect(img) {
    const ar = img.width / img.height;
    const opts = [...$('aspect').options].map(o => o.value);
    return opts.reduce((b, v) => { const [w, h] = v.split('x').map(Number); return Math.abs(Math.log(w / h / ar)) < Math.abs(Math.log(b[0] / b[1] / ar)) ? [w, h] : b; }, [512, 512]);
}
async function fileImage(f) { const img = new Image(); img.src = URL.createObjectURL(f); await img.decode(); return img; }
$('planFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; const img = await fileImage(f); squintSource(img, ...bestAspect(img)); e.target.value = ''; };
$('squint').oninput = () => { if (S.source) squintSource(S.source.img, S.source.W, S.source.H); };
const wrap = $('planWrap');
wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('drag'); });
wrap.addEventListener('dragleave', () => wrap.classList.remove('drag'));
wrap.addEventListener('drop', async e => {
    e.preventDefault(); wrap.classList.remove('drag');
    const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (!f) return;
    const img = await fileImage(f); squintSource(img, ...bestAspect(img));
});

// ── generation ──
seg('mode', v => { S.mode = v; applyModeDefaults(); });
function applyModeDefaults() {
    const d = MODE_DEFAULTS[S.mode];
    $('strength').value = d.strength; $('control').value = d.control; $('modeNote').textContent = d.note;
    $('strengthRow').hidden = S.mode !== 'underpaint'; $('invertRow').hidden = S.mode !== 'depth';
    sliderLabels();
}
function sliderLabels() { $('strengthV').textContent = (+$('strength').value).toFixed(2); $('controlV').textContent = (+$('control').value).toFixed(2); }
$('strength').oninput = $('control').oninput = sliderLabels;
$('reseed').onclick = () => { $('seed').value = Math.floor(Math.random() * 99999); };
$('prompt').oninput = savePlanSoon;

$('go').onclick = async () => {
    if (S.busy) return;
    S.busy = true; $('go').disabled = true; $('progress').hidden = false;
    const n = +$('variants').value, seed0 = +$('seed').value, plan = snapshot(S.plan);
    const planURL = pc.toDataURL('image/png');
    const poll = setInterval(pollStatus, 600);
    const fast = fastOn(), batch = [];
    try {
        for (let v = 0; v < n; v++) {
            $('genNote').textContent = `Variant ${v + 1} of ${n}…`;
            const body = { plan: planURL, prompt: $('prompt').value, mode: S.mode, strength: +$('strength').value,
                           control: +$('control').value, seed: seed0 + v, invert_depth: $('invert').checked, fast,
                           plan_steps: plan.steps, plan_centers: plan.centers };
            const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || r.status);
            const img = new Image(); img.src = j.image; await img.decode();
            batch.push(addResult({ img, plan, run: j.run, label: `${S.mode}${fast ? ' fast' : ''} · s${seed0 + v}`, secs: j.seconds }));
        }
        const best = batch.reduce((a, b) => (b.R.heldPattern > a.R.heldPattern ? b : a));
        select(S.results.indexOf(best));
        $('genNote').textContent = n > 1
            ? `Best of ${n}: ${best.label}, pattern held on ${Math.round(best.R.heldPattern * 100)}% (range ${Math.round(Math.min(...batch.map(r => r.R.heldPattern)) * 100)}–${Math.round(best.R.heldPattern * 100)}%). Saved in grisaille/runs/.`
            : 'Done. Saved in grisaille/runs/.';
    } catch (err) {
        $('genNote').textContent = `Could not generate: ${err.message}`;
    } finally {
        clearInterval(poll); S.busy = false; $('go').disabled = false; $('progress').hidden = true;
        updateRepair();
    }
};
const snapshot = p => ({ ...p, level: p.level.slice(), centers: p.centers.slice() });
async function pollStatus() {
    try {
        const s = await (await fetch('/api/status')).json();
        $('progress').firstElementChild.style.width = s.of ? `${100 * s.step / s.of}%` : '0';
        if (s.status.startsWith('loading')) $('genNote').textContent = `${s.status} (first run only, about a minute)…`;
    } catch { /* ignore */ }
}
async function checkServer() {
    const el = $('server');
    try {
        const s = await (await fetch('/api/status')).json();
        el.textContent = s.ready ? 'generator ready' : 'models missing: run server/fetch_models.py';
        el.className = 'pill ' + (s.ready ? 'ok' : 'bad');
        if (S.ready !== s.ready) { S.ready = s.ready; updateRepair(); }
        $('go').disabled = !s.ready || S.busy;
    } catch {
        el.textContent = 'no generator: start server/serve.py (reading still works)'; el.className = 'pill bad';
        if (S.ready) { S.ready = false; updateRepair(); }
        $('go').disabled = true;
    }
}

// ── results and the receipt ──
const qc = $('pic'), qctx = qc.getContext('2d', { willReadFrequently: true });
function addResult({ img, plan, run, label, secs, parent = null, target = null, before = null }) {
    const c = document.createElement('canvas'); c.width = plan.W; c.height = plan.H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const s = Math.max(plan.W / img.width, plan.H / img.height);
    ctx.drawImage(img, (plan.W - img.width * s) / 2, (plan.H - img.height * s) / 2, img.width * s, img.height * s);
    const rgba = ctx.getImageData(0, 0, plan.W, plan.H).data;
    const R = readAgainst(plan, rgba);
    const res = { canvas: c, rgba, plan, R, run, label, secs, parent, target, before, thumb: c.toDataURL('image/jpeg', 0.8) };
    S.results.push(res);
    if (run) saveReceipt(res);
    select(S.results.length - 1);
    return res;
}
async function saveReceipt(res) {
    try {
        const r = await fetch('/api/receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ run: res.run, receipt: receiptRecord(res.R, { summary: summary(res.R), label: res.label,
                parent: res.parent?.run ?? null, parent_held_pattern: (res.before || res.parent?.R)?.heldPattern ?? null, repair_target: res.target }) }) });
        const j = await r.json(); res.saved = j.saved;
        if (S.results[S.sel] === res) $('saved').textContent = `Receipt saved: grisaille/${j.saved}`;
    } catch { /* reading still shown */ }
}
// The strip, ranked by how much of the plan's pattern held (best first).
function renderStrip() {
    const box = $('strip'); box.innerHTML = '';
    const order = S.results.map((r, i) => i).sort((a, b) => S.results[b].R.heldPattern - S.results[a].R.heldPattern);
    order.forEach((i, rank) => {
        const res = S.results[i], b = document.createElement('button');
        b.style.setProperty('--ar', res.plan.W / res.plan.H);
        b.classList.toggle('on', i === S.sel); b.classList.toggle('best', rank === 0 && S.results.length > 1);
        b.title = res.label;
        b.innerHTML = `<img src="${res.thumb}" alt=""><span>${rank + 1}. ${Math.round(res.R.heldPattern * 100)}% · ${res.label}</span>`;
        b.onclick = () => select(i);
        box.appendChild(b);
    });
}
function select(i) {
    S.sel = i; S.shape = null;
    $('repairTarget').value = S.results[i].R.lostShapes ? 'lost' : 'drift'; repDefault();
    $('picEmpty').hidden = true;
    renderStrip(); drawPic(); drawReceipt();
}
seg('view', v => { S.view = v; drawPic(); });

function drawPic() {
    const res = S.results[S.sel];
    $('legend').hidden = S.view !== 'held' || !res;
    if (!res) { if (S.view === 'plan') { qc.width = S.plan.W; qc.height = S.plan.H; qctx.drawImage(pc, 0, 0); } return; }
    const { plan, R } = res, n = plan.W * plan.H;
    qc.width = plan.W; qc.height = plan.H;
    if (S.view === 'pic') qctx.drawImage(res.canvas, 0, 0);
    else if (S.view === 'plan') { const im = qctx.createImageData(plan.W, plan.H); planToRGBA(plan, im.data); qctx.putImageData(im, 0, 0); }
    else {
        const im = qctx.createImageData(plan.W, plan.H), d = im.data, { L, pattern } = R.maps;
        const css = getComputedStyle(document.documentElement), col = v => hex(css.getPropertyValue(v).trim());
        const cols = { '-2': col('--d2'), '-1': col('--d1'), '1': col('--l1'), '2': col('--l2') };
        for (let i = 0; i < n; i++) {
            let c;
            if (S.view === 'squint') { const g = lToByte(L[i]); c = [g, g, g]; }
            else {
                const dlt = Math.max(-2, Math.min(2, pattern[i] - plan.level[i]));
                if (dlt === 0) { const g = lToByte(L[i]); c = [g * .35 + 160 * .65, g * .35 + 155 * .65, g * .35 + 145 * .65]; }
                else c = cols[dlt];
            }
            d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
        }
        qctx.putImageData(im, 0, 0);
    }
    if (S.shape) {   // outline the chosen shape
        const s = R.shapes.find(s => s.id === S.shape);
        if (s) { qctx.strokeStyle = '#e9a23b'; qctx.lineWidth = 3; qctx.strokeRect(s.box[0], s.box[1], s.box[2] - s.box[0] + 1, s.box[3] - s.box[1] + 1); }
    }
}
const hex = h => { const m = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16)); };

function drawReceipt() {
    const res = S.results[S.sel]; if (!res) return;
    const R = res.R, pc100 = v => `${Math.round(v * 100)}%`;
    $('summary').textContent = summary(R); $('summary').classList.remove('dim');
    const p = res.parent, b = res.before || p?.R;
    $('summary').insertAdjacentHTML('afterbegin', !p ? '' : `<div class="compare">${res.before
        ? `Re-plan of ${p.label}. Against the new plan, before → after repainting: pattern held`
        : `Repair (${res.target}) of ${p.label}: pattern held`}
        ${pc100(b.heldPattern)} → ${pc100(R.heldPattern)}, exact ${pc100(b.heldExact)} → ${pc100(R.heldExact)},
        lost shapes ${b.lostShapes} → ${R.lostShapes}.</div>`);
    $('stats').innerHTML = [
        [pc100(R.heldPattern), 'pattern held'], [pc100(R.heldExact), 'exact values held'],
        [`${R.keyShift > 0 ? '+' : ''}${R.keyShift}`, 'key shift, L*'], [`${Math.round(R.contrast * 100)}%`, 'value range vs plan'],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
    const sw = L => { const g = lToByte(L); return `<i class="sw" style="background:rgb(${g},${g},${g})"></i>`; };
    $('values').innerHTML = `<tr><th>Value</th><th>Plan L*</th><th>Picture L*</th><th>Area</th><th>Held</th></tr>` +
        R.values.map(v => `<tr><td>${sw(v.planL)}${v.k + 1}</td><td>${Math.round(v.planL)}</td>
            <td>${v.meanL === null ? '–' : `${sw(v.meanL)}${v.meanL} ± ${v.sd}`}</td><td>${pc100(v.area)}</td>
            <td>${v.held === null ? '–' : pc100(v.held)}</td></tr>`).join('');
    $('pairs').innerHTML = R.pairs.map(p => `<span class="${p.state}">${p.lo + 1}–${p.hi + 1}: ${p.state} (${p.gap} L*, plan ${p.planGap})</span>`).join('');
    $('shapesHead').hidden = !R.shapes.length;
    $('shapes').innerHTML = R.shapes.slice(0, 12).map(s => `<li data-id="${s.id}" class="${s.lost ? 'lost' : ''} ${s.id === S.shape ? 'sel' : ''}">
        value ${s.k + 1}, ${pc100(s.area)} of frame: ${pc100(s.held)} held${s.lost ? ' (lost)' : ''}</li>`).join('');
    for (const li of $('shapes').children) li.onclick = () => { S.shape = +li.dataset.id === S.shape ? null : +li.dataset.id; if (S.view === 'pic') segSet('view', 'held'); drawPic(); drawReceipt(); };
    $('saved').textContent = res.saved ? `Receipt saved: grisaille/${res.saved}` : res.run ? '' : 'Your own picture: read here only, not saved.';
    updateRepair();
}

// ── repair ──
const pct = v => `${Math.max(v > 0 ? 1 : 0, Math.round(v * 100))}%`;
function updateRepair() {
    const res = S.results[S.sel];
    $('repairBox').hidden = !res;
    if (!res) return;
    const sel = $('repairTarget'), opt = sel.querySelector('[value=shape]');
    const ch = planChangeMask(res.plan, S.plan), hasChanges = ch.ok && ch.changed > 0;
    opt.disabled = !S.shape;
    sel.querySelector('[value=changes]').disabled = !hasChanges;
    if (S.shape) sel.value = 'shape';
    else if (sel.value === 'shape' || (sel.value === 'changes' && !hasChanges)) { const was = sel.value; sel.value = res.R.lostShapes ? 'lost' : 'drift'; if (was === 'changes') repDefault(); }
    const changes = sel.value === 'changes';
    const { frac } = changes ? ch : repairMask(res.plan, res.R, sel.value, S.shape);
    $('repairGo').disabled = !S.ready || S.busy || frac === 0;
    $('repairGo').textContent = changes ? 'Repaint the plan changes' : 'Repair this picture';
    const need = S.ready ? '' : ' (Needs the generator.)';
    $('repairNote').textContent = changes
        ? `You changed ${pct(ch.changed)} of the plan since this picture. Repaints ${pct(frac)} of the picture (the changes and their edge); the rest stays exactly as it is.${ch.changed > 0.4 ? ' That is most of it: Generate may suit better.' : ''}${need}`
        : frac === 0 ? (ch.ok ? 'Nothing to repair for this choice. Or edit the plan (card 1) and repaint just what you changed.' : `Nothing to repair for this choice. (Plan changes: ${ch.reason}, so they cannot be repainted locally.)`)
        : `Repaints ${pct(frac)} of the picture; the rest stays exactly as it is.${need}`;
}
// plan changes repaint harder than repairs (a moved mass has to be painted, not pasted)
function repDefault() { $('repStr').value = $('repairTarget').value === 'changes' ? CHANGE_REPAINT : 0.6; $('repStrV').textContent = (+$('repStr').value).toFixed(2); }
$('repairTarget').onchange = () => { repDefault(); if ($('repairTarget').value !== 'shape') S.shape = null; drawPic(); drawReceipt(); };
$('repStr').oninput = () => { $('repStrV').textContent = (+$('repStr').value).toFixed(2); };
$('repairGo').onclick = async () => {
    const res = S.results[S.sel];
    if (!res || S.busy) return;
    const target = $('repairTarget').value, changes = target === 'changes';
    // plan changes: the new plan is the one to hold; only the changed pixels get their values moved
    const plan = changes ? snapshot(S.plan) : res.plan;
    let mask, core;
    if (changes) ({ mask, core } = planChangeMask(res.plan, plan));
    else core = mask = repairMask(res.plan, res.R, target, S.shape).mask;
    const corrected = correctValues(res.rgba, plan, res.R, core);
    const before = changes ? readAgainst(plan, res.rgba) : null;   // the picture as it was, read against the new plan
    const toURL = rgba => { const c = document.createElement('canvas'); c.width = plan.W; c.height = plan.H;
        c.getContext('2d').putImageData(new ImageData(rgba, plan.W, plan.H), 0, 0); return c.toDataURL('image/png'); };
    const planURL = toURL(planToRGBA(plan));
    S.busy = true; $('repairGo').disabled = $('go').disabled = true; $('progress').hidden = false;
    $('repairNote').textContent = 'Repairing…';
    const poll = setInterval(pollStatus, 600);
    try {
        const body = { image: toURL(corrected), mask: toURL(maskToRGBA(mask)), plan: planURL, prompt: $('prompt').value,
                       strength: +$('repStr').value, control: 0.8, seed: +$('seed').value, fast: fastOn(),
                       parent: res.run, target: target === 'shape' ? `shape ${S.shape}` : changes ? 'plan change' : target,
                       plan_steps: plan.steps, plan_centers: plan.centers };
        const r = await fetch('/api/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.status);
        const img = new Image(); img.src = j.image; await img.decode();
        addResult({ img, plan, run: j.run, label: `${changes ? 're-plan' : 'repair'} of ${res.label}`, secs: j.seconds, parent: res, target: body.target, before });
    } catch (err) {
        $('repairNote').textContent = `Could not repair: ${err.message}`;
    } finally {
        clearInterval(poll); S.busy = false; $('go').disabled = !S.ready; $('progress').hidden = true; updateRepair();
    }
};
// Fast (LCM-LoRA) was tested on 13 Nov and not shipped: it holds the plan by painting less (README).
const fastOn = () => false;

$('ownFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const img = await fileImage(f);
    addResult({ img, plan: snapshot(S.plan), run: null, label: 'yours' });
    e.target.value = '';
};

// ── small helpers ──
function seg(id, on) {
    for (const b of $(id).children) b.addEventListener('click', () => { segSet(id, b.dataset.v); on(b.dataset.v); });
}
function segSet(id, v) { for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === v); if (id === 'tool') S.tool = v; if (id === 'view') { S.view = v; drawPic(); } }

// ── start ──
setPlan(loadPlan() || newPlan(512, 512, 3), true);
applyModeDefaults();
checkServer(); setInterval(checkServer, 15000);
window.__grisaille = S;   // for inspection
