/**
 * End-to-end smoke test in a real browser, driving the WebGL fallback path via
 * SwiftShader (headless Chrome has no WebGPU). Verifies renderer init, GLB load
 * and normalisation, UI wiring, the button enable/disable state machine, and
 * that the drone actually flies. Writes screenshots to SHOT_DIR.
 *
 *   npm run build && npm run preview      # in one terminal
 *   npm run test:browser                  # in another
 *
 * Timing note: SwiftShader renders at a few FPS, and the substep cap makes the
 * simulation deliberately run in slow motion when the renderer can't keep up.
 * All waits are therefore on *simulated* time (`simWait`) — wall-clock waits
 * would measure the rasteriser rather than the flight model.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

// ?dof=0: the depth-of-field pass is a full-screen multi-pass blur and is
// unusably slow under SwiftShader. It is verified separately on a real GPU.
const URL = process.argv[2] ?? 'http://localhost:4173/?dof=0';
const SHOT_DIR = process.argv[3] ?? 'tests';

/** Uses an already-installed browser — puppeteer-core downloads nothing. */
function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found — set CHROME_PATH to your browser binary.');
  return found;
}

const CHROME = findBrowser();

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=900,700',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });

const errors = [];
const warnings = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') errors.push(m.text());
  else if (t === 'warning') warnings.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

/**
 * Wait for N seconds of *simulated* time, not wall-clock. Under a software
 * rasteriser the sim intentionally runs in slow motion (substep cap), so
 * wall-clock waits would measure the GPU rather than the flight model.
 */
async function simWait(seconds) {
  const target = (await page.evaluate(() => window.__sim.simTime())) + seconds;
  await page.waitForFunction(
    (t) => window.__sim.simTime() >= t,
    { timeout: 300000, polling: 30 },
    target,
  );
}

console.log(`\nLoading ${URL} …`);
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

// --- boot ----------------------------------------------------------------
console.log('\n=== boot ===');
try {
  await page.waitForFunction(
    () => document.querySelector('#loader')?.classList.contains('is-hidden'),
    { timeout: 60000 },
  );
  ok('loader hidden (boot completed)', true);
} catch {
  const txt = await page.$eval('#loader-text', (e) => e.textContent).catch(() => '?');
  ok('loader hidden (boot completed)', false, `loader stuck on: "${txt}"`);
}

const backend = await page.$eval('#hud-backend', (e) => e.textContent);
console.log(`  INFO  renderer backend: ${backend}`);
ok('canvas present', (await page.$('#viewport')) !== null);

const canvasSize = await page.$eval('#viewport', (c) => ({ w: c.width, h: c.height }));
ok('canvas sized', canvasSize.w > 0 && canvasSize.h > 0, JSON.stringify(canvasSize));

// --- model normalisation --------------------------------------------------
console.log('\n=== model ===');
const modelInfo = await page.evaluate(() => window.__sim?.modelInfo?.() ?? null);
if (modelInfo) {
  console.log(`  INFO  normalised bbox (m): ${JSON.stringify(modelInfo.size)}`);
  console.log(`  INFO  triangles: ${modelInfo.triangles}, meshes: ${modelInfo.meshes}`);
  ok('model scaled to ~0.18 m span', Math.abs(Math.max(modelInfo.size[0], modelInfo.size[2]) - 0.18) < 0.005);
  ok('model has geometry', modelInfo.triangles > 0);
  console.log(`  INFO  rotors: ${modelInfo.rotorCount} ${JSON.stringify(modelInfo.rotorNames)}`);
  ok('all four rotors bound', modelInfo.rotorCount === 4);
  // The stock clip is a spin-up/spin-down ramp, so procedural spin must win.
  ok('spun procedurally, not from the GLB clip', modelInfo.hasMixer === false);
} else {
  ok('debug hook available', false, '(window.__sim missing)');
}

// --- UI state machine -----------------------------------------------------
const btnState = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-cmd],[data-action]')].map((b) => [
        b.dataset.action ?? b.dataset.cmd,
        !b.disabled,
      ]),
    ),
  );

console.log('\n=== UI: landed ===');
let s = await btnState();
ok('flight button enabled (reads Takeoff)', s.flight === true);
ok('flight button labelled Takeoff', (await page.$eval('#btn-flight', (e) => e.textContent)).includes('Takeoff'));

ok('movement disabled', s.forward === false && s.up === false && s.yawLeft === false);
ok('flips disabled', s.flipLeft === false && s.flipRight === false);
await page.screenshot({ path: `${SHOT_DIR}/01-landed.png` });

console.log('\n=== UI: T/L keyboard shortcuts ===');
// Regression test: T and L used to map to 'takeoff'/'land' actions that no
// button's data-action matches since Takeoff/Land merged into one button
// (data-action="flight") — _buttonFor() found nothing, so the key silently
// did nothing. Exercised here via the real keys, not a click, specifically so
// that stale-action-name bug can't come back unnoticed.
await page.keyboard.press('KeyT');
await page.waitForFunction(() => window.__sim.drone().state !== 'landed', { timeout: 5000 });
ok('T starts takeoff', (await page.evaluate(() => window.__sim.drone().state)) === 'takingOff');
await page.waitForFunction(() => window.__sim.drone().state === 'flying', { timeout: 180000 });
await page.keyboard.press('KeyL');
await page.waitForFunction(() => window.__sim.drone().state !== 'flying', { timeout: 5000 });
ok('L starts landing', (await page.evaluate(() => window.__sim.drone().state)) === 'landing');
await page.waitForFunction(() => window.__sim.drone().state === 'landed', { timeout: 180000 });
ok('back to landed', (await page.evaluate(() => window.__sim.drone().state)) === 'landed');

console.log('\n=== UI: taking off (all buttons locked) ===');
await page.click('[data-action="flight"]');
await simWait(0.3);
s = await btnState();
const st = await page.$eval('#hud-state', (e) => e.textContent);
console.log(`  INFO  hud state: ${st}`);
ok('flight button disabled during climb', s.flight === false);

ok('movement disabled during climb', s.forward === false && s.up === false);
ok('flips disabled during climb', s.flipLeft === false);

console.log('\n=== UI: reached hover ===');
await page.waitForFunction(() => document.querySelector('#hud-state')?.dataset.state === 'flying', {
  timeout: 180000,
});
s = await btnState();
const alt = await page.$eval('#hud-altitude', (e) => e.textContent);
console.log(`  INFO  altitude at hover: ${alt}`);
ok('flight button now reads Land', (await page.$eval('#btn-flight', (e) => e.textContent)).includes('Land'));
ok('flight button enabled in flight', s.flight === true);
ok('movement enabled while flying', s.forward && s.backward && s.left && s.right && s.up && s.down && s.yawLeft && s.yawRight);
ok('flips enabled while flying', s.flipLeft === true && s.flipRight === true);
await page.screenshot({ path: `${SHOT_DIR}/02-hover.png` });

// --- rotors ---------------------------------------------------------------
// Must run while airborne: the props correctly spool to zero once landed.
console.log('\n=== rotors spin continuously in flight ===');
// Sampled per rendered frame, since the phase only advances in syncVisual —
// wall-clock polling would measure the rasteriser rather than the rotors.
const spin = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const out = [];
      const tick = () => {
        const d = window.__sim.drone();
        out.push({ phase: d._rotorPhase, speed: d._rotorSpeed });
        if (out.length < 150) requestAnimationFrame(tick);
        else resolve(out);
      };
      requestAnimationFrame(tick);
    }),
);
let spinStalls = 0;
let spinReversals = 0;
for (let i = 1; i < spin.length; i += 1) {
  const step = spin[i].phase - spin[i - 1].phase;
  if (step < 0) spinReversals += 1;
  if (step <= 0) spinStalls += 1;
}
console.log(
  `  INFO  ${spin.length} frames, ${(spin.at(-1).phase / (2 * Math.PI)).toFixed(0)} revolutions, ` +
    `speed factor ${spin.at(-1).speed.toFixed(2)}`,
);
ok('never stalls mid-flight', spinStalls === 0, `${spinStalls} frames without advance`);
ok('never reverses', spinReversals === 0);
ok('rate stays above the airborne idle floor', spin.at(-1).speed >= 0.5);

// --- flight ---------------------------------------------------------------
console.log('\n=== flight: hold Forward ===');
const before = await page.evaluate(() => window.__sim.pose());
const fwd = await page.$('[data-cmd="forward"]');
const box = await fwd.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await simWait(1.2);
const during = await page.evaluate(() => window.__sim.pose());
await page.screenshot({ path: `${SHOT_DIR}/03-forward-tilt.png` });
await page.mouse.up();
console.log(`  INFO  pitch while held: ${during.pitchDeg.toFixed(1)}°`);
ok('model tilts nose-down ~15°', Math.abs(during.pitchDeg + 15) < 2);
ok('drone moved forward (-Z)', during.z < before.z - 0.2, `dz=${(during.z - before.z).toFixed(2)}m`);
// Altitude hold is on *world* height, not height-above-ground: the terrain
// rises and falls under the drone, and clamping to AGL would make it climb
// every time it crossed a hill. So check world y, and report the AGL drift.
console.log(
  `  INFO  world y ${before.y.toFixed(2)} -> ${during.y.toFixed(2)} m; ` +
    `AGL ${before.altitude.toFixed(2)} -> ${during.altitude.toFixed(2)} m (terrain fell away)`,
);
ok('world altitude held while translating', Math.abs(during.y - before.y) < 0.12,
  `dy=${(during.y - before.y).toFixed(3)}m`);

await simWait(2.0);
const stopped = await page.evaluate(() => window.__sim.pose());
ok('auto-brake levels the drone', Math.abs(stopped.pitchDeg) < 3, `pitch=${stopped.pitchDeg.toFixed(1)}°`);
ok('auto-brake stops the drone', stopped.speed < 0.2, `speed=${stopped.speed.toFixed(2)}m/s`);

console.log('\n=== flight: flip ===');
const beforeFlip = await page.evaluate(() => window.__sim.pose());
const flipAlt = beforeFlip.altitude;
await page.click('[data-action="flipRight"]');
await simWait(0.2);
const mid = await page.evaluate(() => window.__sim.pose());
console.log(`  INFO  flipRoll mid-manoeuvre: ${mid.flipRollDeg.toFixed(0)}°`);
ok('flip in progress', mid.isFlipping === true);
s = await btnState();
ok('controls locked during flip', s.forward === false && s.flight === false);
await page.screenshot({ path: `${SHOT_DIR}/04-flip.png` });
await page.waitForFunction(() => window.__sim.pose().isFlipping === false, { timeout: 120000, polling: 30 });
const after = await page.evaluate(() => window.__sim.pose());
ok('flip completed and reset', after.flipRollDeg === 0);
// Flown, not animated: the rotation is integrated from rotor torque, so the
// drone carries angular momentum, and the height it gains comes from a banked
// entry followed by a ballistic inverted half.
console.log(`  INFO  roll rate mid-rotation: ${mid.flipRate.toFixed(1)} rad/s, phase ${mid.flipPhase}`);
ok('carries real angular velocity', Math.abs(mid.flipRate) > 1);
ok('rate released at exit', after.flipRate === 0);
console.log(`  INFO  altitude: ${flipAlt.toFixed(2)} -> ${mid.altitude.toFixed(2)} -> ${after.altitude.toFixed(2)} m`);
ok('gains height under its own thrust', mid.altitude > flipAlt + 0.05);
// The visible half of the fix the manoeuvre was retuned for: reference footage
// of a Tello flip climbs about 1.4 airframe spans, not the 4.7 the old
// straight-up punch produced.
const span = await page.evaluate(() => window.__sim.drone().span);
ok('does not balloon upward', mid.altitude < flipAlt + span * 2.5,
  `+${(mid.altitude - flipAlt).toFixed(2)}m = ${((mid.altitude - flipAlt) / span).toFixed(1)} spans`);

await simWait(3);
const settledFlip = await page.evaluate(() => window.__sim.pose());
const flipTravel = Math.hypot(settledFlip.x - beforeFlip.x, settledFlip.z - beforeFlip.z);
console.log(`  INFO  settled ${flipTravel.toFixed(2)}m = ${(flipTravel / span).toFixed(1)} spans from the entry point`);
ok('returns to entry altitude', Math.abs(settledFlip.altitude - flipAlt) < 0.08,
  `${settledFlip.altitude.toFixed(2)}m vs ${flipAlt.toFixed(2)}m`);
// The banked entry is the only thing pushing it sideways, so this is also the
// check that the entry angle survived any retune.
ok('and travels across the room, not on the spot', flipTravel > span * 2,
  `${flipTravel.toFixed(2)}m`);

console.log('\n=== camera: keeps station through a turn ===');
// The chase view has to swing round *with* the drone, not slew into place after
// it. Held yaw is the worst case: a first-order tracker settles at a constant
// lag of (yaw rate / smoothing), so this measures the steady-state error rather
// than a transient.
const yawBtn = await page.$('[data-cmd="yawLeft"]');
const yawBox = await yawBtn.boundingBox();
await page.mouse.move(yawBox.x + yawBox.width / 2, yawBox.y + yawBox.height / 2);
await page.mouse.down();
await simWait(1.5); // long enough for the lag to reach steady state
const turning = await page.evaluate(() => ({
  ...window.__sim.camera(),
  yawDeg: (window.__sim.drone().yaw * 180) / Math.PI,
}));
await page.mouse.up();
const lag = Math.abs(((turning.azimuthDeg - turning.yawDeg + 540) % 360) - 180);
console.log(`  INFO  camera azimuth ${turning.azimuthDeg.toFixed(0)}° vs heading ${turning.yawDeg.toFixed(0)}° — lag ${lag.toFixed(0)}°`);
ok('camera stays with the drone through a 100°/s turn', lag < 25, `${lag.toFixed(0)}° behind`);
console.log(`  INFO  chase distance ${turning.distance.toFixed(2)}m = ${(turning.distance / span).toFixed(1)} spans`);
ok('chase view is over-the-shoulder, not a wide shot', turning.distance < span * 4.5,
  `${turning.distance.toFixed(2)}m`);
await simWait(1.5);

console.log('\n=== UI: landing ===');
await page.click('[data-action="flight"]');
await simWait(0.15);
s = await btnState();
ok('movement locked during landing', s.forward === false && s.up === false && s.yawLeft === false);
ok('flips locked during landing', s.flipLeft === false);
ok('flight button disabled during landing', s.flight === false);
await page.waitForFunction(() => document.querySelector('#hud-state')?.dataset.state === 'landed', {
  timeout: 180000,
});
s = await btnState();
const finalAlt = await page.$eval('#hud-altitude', (e) => e.textContent);
console.log(`  INFO  final altitude: ${finalAlt}`);
ok('flight button re-enabled and back to Takeoff', s.flight === true && (await page.$eval('#btn-flight', (e) => e.textContent)).includes('Takeoff'));
ok('touched down at y=0', parseFloat(finalAlt) < 0.02);
await page.screenshot({ path: `${SHOT_DIR}/05-landed-again.png` });

// --- camera ---------------------------------------------------------------
console.log('\n=== camera: drag to orbit ===');
const cam0 = await page.evaluate(() => window.__sim.camera());
console.log(`  INFO  home: az=${cam0.azimuthDeg.toFixed(0)}° el=${cam0.elevationDeg.toFixed(0)}° d=${cam0.distance.toFixed(2)}m`);
ok('auto camera on by default', cam0.autoFollow === true);

// Drag across empty scene (well clear of every panel).
await page.mouse.move(450, 300);
await page.mouse.down();
for (let i = 1; i <= 10; i += 1) await page.mouse.move(450 + i * 12, 300 + i * 3);
await page.mouse.up();
const cam1 = await page.evaluate(() => window.__sim.camera());
console.log(`  INFO  after drag: az=${cam1.azimuthDeg.toFixed(0)}° el=${cam1.elevationDeg.toFixed(0)}°`);
ok('drag changed azimuth', Math.abs(cam1.azimuthDeg - cam0.azimuthDeg) > 15);
ok('drag changed elevation', Math.abs(cam1.elevationDeg - cam0.elevationDeg) > 3);
await page.screenshot({ path: `${SHOT_DIR}/06-orbited.png` });

console.log('\n=== camera: zoom limits ===');
await page.evaluate(() => window.__sim.scene().setZoom01(0));
const near = await page.evaluate(() => window.__sim.camera());
await page.evaluate(() => window.__sim.scene().setZoom01(1));
const far = await page.evaluate(() => window.__sim.camera());
console.log(`  INFO  zoom range: ${near.distance.toFixed(2)}m .. ${far.distance.toFixed(2)}m`);
// Expressed in spans, not metres: what must hold is that the closest zoom
// still leaves the camera outside the airframe (half a span from its centre),
// whatever drone is loaded and however close the default framing is set.
ok('nearest is clamped outside the airframe', near.distance > span * 1.2 && near.distance <= far.distance,
  `${near.distance.toFixed(2)}m = ${(near.distance / span).toFixed(1)} spans`);
// Furthest is world-relative now, not drone-relative: in a 500 m village you
// have to be able to pull back far enough to see what you are flying over.
ok('furthest reaches far enough to frame the world', far.distance > 20 && far.distance < 60);
await page.evaluate(() => window.__sim.scene().setZoom01(0));
await page.screenshot({ path: `${SHOT_DIR}/07-zoom-near.png` });

// Wheel zoom over empty space.
await page.mouse.move(450, 300);
const beforeWheel = (await page.evaluate(() => window.__sim.camera())).distance;
await page.mouse.wheel({ deltaY: 400 });
const afterWheel = (await page.evaluate(() => window.__sim.camera())).distance;
ok('wheel zooms out', afterWheel > beforeWheel, `${beforeWheel.toFixed(2)} -> ${afterWheel.toFixed(2)}m`);

// syncZoom() only runs on the throttled HUD tick (main.js, every 0.1s), so the
// slider needs a moment to catch up to the wheel input before checking it.
await simWait(0.2);
const sliderCheck = await page.evaluate(() => {
  const slider = document.getElementById('zoom-slider');
  const max = Number(slider.max) || 1000;
  const zoom01 = window.__sim.scene().getZoom01();
  // Mirrors UIManager.syncZoom()'s own formula — the slider runs the opposite
  // way from the distance-based camera API (0 = closest).
  const expected = Math.round((1 - zoom01) * max);
  return { value: Number(slider.value), expected };
});
ok(
  'slider tracks the wheel',
  Math.abs(sliderCheck.value - sliderCheck.expected) <= 1,
  `slider=${sliderCheck.value} expected=${sliderCheck.expected}`,
);

console.log('\n=== camera: auto-adjust returns home ===');
/** Signed angular distance from the camera's azimuth to "behind the drone". */
const offHomeDeg = (cam, yawDeg) => Math.abs((((cam.azimuthDeg - yawDeg) % 360) + 540) % 360 - 180);

await page.evaluate(() => window.__sim.scene().orbit(400, 0));
const swung = await page.evaluate(() => window.__sim.camera());
const yawWhenSwung = (await page.evaluate(() => window.__sim.pose())).yawDeg;
ok('drag moved the camera off home', offHomeDeg(swung, yawWhenSwung) > 60);

// Poll for convergence rather than asserting a fixed wall-clock deadline: the
// easing advances per rendered frame, so a software rasteriser reaches home in
// real seconds rather than the ~1s a 60 FPS device takes.
const startedWaiting = Date.now();
let returnedHome = true;
try {
  await page.waitForFunction(
    () => {
      const c = window.__sim.camera();
      const p = window.__sim.pose();
      return Math.abs((((c.azimuthDeg - p.yawDeg) % 360) + 540) % 360 - 180) < 8;
    },
    { timeout: 60000, polling: 100 },
  );
} catch {
  returnedHome = false;
}
const returned = await page.evaluate(() => window.__sim.camera());
const droneYawDeg = (await page.evaluate(() => window.__sim.pose())).yawDeg;
console.log(
  `  INFO  swung ${offHomeDeg(swung, yawWhenSwung).toFixed(0)}° off home, back to ` +
    `${offHomeDeg(returned, droneYawDeg).toFixed(0)}° after ${((Date.now() - startedWaiting) / 1000).toFixed(1)}s`,
);
ok('auto camera returned behind the drone', returnedHome);
ok('and restored the default distance', Math.abs(returned.distance - cam0.distance) < 0.06,
  `${returned.distance.toFixed(2)} vs home ${cam0.distance.toFixed(2)}m`);

// It must NOT drift home while the user is still interacting.
await page.evaluate(() => window.__sim.scene().orbit(300, 0));
const justMoved = await page.evaluate(() => window.__sim.camera());
await new Promise((r) => setTimeout(r, 1500)); // well inside the 3s delay
const stillThere = await page.evaluate(() => window.__sim.camera());
ok('holds position during the 3s grace period',
  Math.abs(stillThere.azimuthDeg - justMoved.azimuthDeg) < 1);

console.log('\n=== camera: a control input starts the return early, but eases ===');
await page.evaluate(() => window.__sim.scene().orbit(500, 120));
const swungAgain = await page.evaluate(() => window.__sim.camera());
const yawNow = (await page.evaluate(() => window.__sim.pose())).yawDeg;
ok('camera is off home before the input', offHomeDeg(swungAgain, yawNow) > 60);

// Tap a movement button. It is disabled while landed, so drive the same entry
// point the button uses — this asserts the snap, not the button's enablement.
const startOff = offHomeDeg(swungAgain, yawNow);
await page.evaluate(() => window.__sim.scene().returnHome());

// One frame later it must still be en route — a hard cut to home would read as
// a teleport mid-flight, which is exactly what this replaced.
await new Promise((r) => setTimeout(r, 450));
const oneFrameIn = offHomeDeg(
  await page.evaluate(() => window.__sim.camera()),
  (await page.evaluate(() => window.__sim.pose())).yawDeg,
);
ok('does not cut instantly to home', oneFrameIn > 5, `${oneFrameIn.toFixed(0)}° off after ~1 frame`);

// It must be visibly closing before the 3s idle delay could have fired. Counted
// in *rendered frames*, not wall-clock: the easing advances per frame, and this
// scene is heavy enough under SwiftShader that a fixed delay can cover only one
// or two frames and read as a stall that isn't there.
await page.evaluate(
  () =>
    new Promise((resolve) => {
      let n = 0;
      const tick = () => (n++ < 20 ? requestAnimationFrame(tick) : resolve());
      requestAnimationFrame(tick);
    }),
);
const earlyOff = offHomeDeg(
  await page.evaluate(() => window.__sim.camera()),
  (await page.evaluate(() => window.__sim.pose())).yawDeg,
);
console.log(`  INFO  ${startOff.toFixed(0)}° off home -> ${oneFrameIn.toFixed(0)}° -> ${earlyOff.toFixed(0)}° (easing, no 3s wait)`);
ok('return is already underway, without the 3s wait', earlyOff < startOff * 0.7);

// Azimuth *and* elevation: they ease at the same rate but from different
// displacements, so waiting on azimuth alone samples elevation mid-flight.
await page.waitForFunction(
  (defaultElevationDeg) => {
    const c = window.__sim.camera();
    const p = window.__sim.pose();
    const az = Math.abs((((c.azimuthDeg - p.yawDeg) % 360) + 540) % 360 - 180);
    return az < 8 && Math.abs(c.elevationDeg - defaultElevationDeg) < 1.5;
  },
  { timeout: 120000, polling: 30 },
  cam0.elevationDeg,
);
const settledBack = await page.evaluate(() => window.__sim.camera());
ok('completes the return', true);
ok('and eases elevation back to default', Math.abs(settledBack.elevationDeg - cam0.elevationDeg) < 2);
ok('and eases the zoom back', Math.abs(settledBack.distance - cam0.distance) < 0.05);

console.log('\n=== camera: auto-adjust off holds position ===');
await page.click('[data-toggle="autoCamera"]');
const offState = await page.evaluate(() => window.__sim.camera());
ok('toggle turned auto camera off', offState.autoFollow === false);
await page.evaluate(() => window.__sim.scene().orbit(300, 0));
const held0 = await page.evaluate(() => window.__sim.camera());
await new Promise((r) => setTimeout(r, 4200));
const held1 = await page.evaluate(() => window.__sim.camera());
ok('camera stayed where the user left it', Math.abs(held1.azimuthDeg - held0.azimuthDeg) < 1);
await page.click('[data-toggle="autoCamera"]');
ok('toggle turned auto camera back on', (await page.evaluate(() => window.__sim.camera())).autoFollow === true);

// --- perf -----------------------------------------------------------------
console.log('\n=== perf ===');
const fps = await page.$eval('#hud-fps', (e) => e.textContent);
console.log(`  INFO  FPS (SwiftShader software rasteriser, not representative): ${fps}`);

// --- console health -------------------------------------------------------
console.log('\n=== console ===');
const realErrors = errors.filter((e) => !/favicon/i.test(e));
ok('no console errors', realErrors.length === 0);
for (const e of realErrors) console.log(`        ERROR: ${e}`);
if (warnings.length) {
  console.log(`  INFO  ${warnings.length} warning(s):`);
  for (const w of [...new Set(warnings)].slice(0, 8)) console.log(`        WARN: ${w}`);
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL BROWSER CHECKS PASSED' : `${failures} BROWSER CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
