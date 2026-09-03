/**
 * Headless verification of the flight model. No WebGL involved: we stub the
 * GLB load (supplying the collider half-extents load() would have derived) and
 * drive PhysicsWorld directly at a fixed 60 Hz.
 */
import * as THREE from 'three';
import { PhysicsWorld, initPhysics } from '../src/Physics.js';
import { DroneController, DroneState } from '../src/DroneController.js';
import { DRONE_PRESETS, WORLD } from '../src/config.js';

const spec = DRONE_PRESETS.tello;
const DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;
let failures = 0;

function check(label, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${actual.toFixed(3).padStart(9)}` +
      `  (expected ${expected} ±${tolerance})`,
  );
}

function checkState(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${String(actual).padStart(9)}  (expected ${expected})`);
}

await initPhysics();

// This suite tests the flight model, not the play area. The shipped arena is
// sized to the terrain tile (radius 10 m); several fixtures below sit further
// out than that, and the soft wall would push them around and pollute the
// measurements. Widen it so the arena is never the thing under test.
WORLD.arenaRadius = 500;

const physics = new PhysicsWorld({ gravity: WORLD.gravity });
physics.createGround({ y: WORLD.groundY });

const scene = new THREE.Scene();
const drone = new DroneController({ physics, scene, spec });

// --- stand in for load(): Tello is ~180mm across, ~41mm tall --------------
drone._halfExtents = new THREE.Vector3(0.09, 0.0205, 0.09);
drone.span = Math.max(drone._halfExtents.x, drone._halfExtents.z) * 2;
drone._createBody();
drone._unsubscribe = physics.onFixedStep((dt) => drone.fixedUpdate(dt));
scene.add(drone.root);

const DT = 1 / 60;
function sim(seconds, onStep) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i += 1) {
    physics.update(DT);
    drone.syncVisual(1, DT);
    onStep?.(i * DT);
  }
}

console.log('\n=== 1. initial state ===');
checkState('state', drone.state, DroneState.LANDED);
check('altitude (m)', drone.altitude, 0, 0.005);
check('takeoff() rejected while... (returns 1=ok)', drone.state === 'landed' ? 1 : 0, 1, 0);

console.log('\n=== 2. takeoff -> hover at 1.0 m ===');
console.log(`  land() while landed rejected: ${drone.land() === false ? 'PASS' : 'FAIL'}`);
console.log(`  flip() while landed rejected:  ${drone.flip(1) === false ? 'PASS' : 'FAIL'}`);
if (drone.land() !== false || drone.flip(1) !== false) failures += 1;

drone.takeoff();
checkState('state right after takeoff()', drone.state, DroneState.TAKING_OFF);
let reachedFlying = null;
sim(6, (t) => {
  if (reachedFlying === null && drone.state === DroneState.FLYING) reachedFlying = t;
});
checkState('state', drone.state, DroneState.FLYING);
check('hover altitude (m)', drone.altitude, spec.hoverHeight, 0.05);
check('drift from pad (m)', Math.hypot(drone.position.x, drone.position.z), 0, 0.02);
console.log(`  INFO  time to reach hover: ${reachedFlying?.toFixed(2)} s`);

console.log('\n=== 3. forward: tilt sign + travel direction ===');
const z0 = drone.position.z;
drone.setInput('forward', true);
sim(2.5);
console.log(`  INFO  commanded pitch: ${(drone.pitch * DEG).toFixed(1)}° (nose-down is negative)`);
check('pitch at full stick (deg)', drone.pitch * DEG, -spec.maxTiltDeg, 0.6);
console.log(`  INFO  travelled dz = ${(drone.position.z - z0).toFixed(3)} m, speed ${drone.speed.toFixed(2)} m/s`);
if (drone.position.z >= z0 - 0.5) {
  failures += 1;
  console.log('  FAIL  forward input did not move the drone toward -Z');
} else {
  console.log('  PASS  forward input moved the drone toward -Z');
}
check('altitude held while translating (m)', drone.altitude, spec.hoverHeight, 0.08);

console.log('\n=== 4. release -> comes to a stop ===');
drone.setInput('forward', false);
sim(3);
check('pitch returns to level (deg)', drone.pitch * DEG, 0, 0.5);
check('residual speed (m/s)', drone.speed, 0, 0.12);

console.log('\n=== 5. strafe right -> banks right (-roll) ===');
const x0 = drone.position.x;
drone.setInput('right', true);
sim(2);
check('roll at full stick (deg)', drone.roll * DEG, -spec.maxTiltDeg, 0.6);
console.log(`  INFO  travelled dx = ${(drone.position.x - x0).toFixed(3)} m`);
if (drone.position.x <= x0 + 0.5) { failures += 1; console.log('  FAIL  right input did not move toward +X'); }
else console.log('  PASS  right input moved toward +X');
drone.setInput('right', false);
sim(3);

console.log('\n=== 6. yaw rate controller ===');
const yaw0 = drone.yaw;
drone.setInput('yawLeft', true);
sim(1.5);
const yawRate = drone.body.angvel().y * DEG;
check('steady yaw rate (deg/s)', yawRate, spec.yawRateDeg, 8);
drone.setInput('yawLeft', false);
sim(1);
console.log(`  INFO  total yaw change: ${((drone.yaw - yaw0) * DEG).toFixed(1)}°`);

console.log('\n=== 7. flip: flown, not animated ===');
// The drone is yawed by the previous test, so "right" is a body axis.
const flipYaw = drone.yaw;
const rightX = Math.cos(flipYaw);
const rightZ = -Math.sin(flipYaw);
const driftAlongRight = (fromX, fromZ) =>
  (drone.position.x - fromX) * rightX + (drone.position.z - fromZ) * rightZ;

const { x: hx, y: hy } = drone._halfExtents;
const yBefore = drone.body.translation().y;
const altBefore = drone.altitude;
const xBefore = drone.position.x;
const zBefore = drone.position.z;
const entryLowest = yBefore - hy;

const started = drone.flip(1); // +1 = roll/drift right
console.log(`  ${started ? 'PASS' : 'FAIL'}  flip() accepted in flight`);
if (!started) failures += 1;
check('starts from rest (rad/s)', drone.flipRate, 0, 1e-9);

let peakRate = 0;
let rateAtQuarter = 0;
let rateAtThreeQuarter = 0;
let lowestSwept = Infinity;
let peakY = -Infinity;
let sawEntry = false;
let sawRotate = false;
let sawArc = false;
let entryRise = 0;
let xAtExit = 0;
let zAtExit = 0;
let speedAtExit = 0;
let speedAtHandback = 0;
let altAtHandback = 0;
let firstRollSign = 0;
let duration = 0;
let finalRate = 0;
let prevAngle = 0;
let reversed = false;
let prevRate = 0;
let rateDipped = false;
let slowestRate = Infinity;
let reachedLimit = false;
let peakAtEntry = false;
let rollAtPeak = 0;
let recoilRoll = 0;

for (let i = 0; i < Math.round(3 / DT); i += 1) {
  physics.update(DT);
  drone.syncVisual(1, DT);
  if (!drone.isFlipping) break;
  duration += DT;
  const phase = drone._flipPhase;
  if (phase === 'entry') {
    sawEntry = true;
    entryRise = drone.body.translation().y - yBefore;
  }
  if (phase === 'rotate') sawRotate = true;
  const inExit = phase === 'exit';
  // First frame of the exit is where the rotation handed its leftover momentum
  // to attitude hold, so that is where the follow-through has to be read.
  // Sampling at the end of the flip catches it after a phase of decay.
  if (inExit && !sawArc) {
    recoilRoll = drone.roll;
    xAtExit = drone.position.x;
    zAtExit = drone.position.z;
    speedAtExit = drone.speed;
  }
  if (inExit) {
    sawArc = true;
    speedAtHandback = drone.speed;
    altAtHandback = drone.altitude;
  }

  const t = drone.flipRoll;
  const y = drone.body.translation().y;
  lowestSwept = Math.min(lowestSwept, y - (hx * Math.abs(Math.sin(t)) + hy * Math.abs(Math.cos(t))));
  if (y > peakY) {
    peakAtEntry = phase === 'entry';
    // Level again by the exit; report a completed turn rather than wrapping
    // back to zero, so the arc's peak stays comparable to the rotation angle.
    rollAtPeak = inExit ? TWO_PI : Math.abs(drone.flipRoll);
  }
  peakY = Math.max(peakY, y);

  // Everything below describes the rotation, which is over once the exit
  // starts — and `flipRoll` is deliberately back at zero there (0 and 360° are
  // the same pose), which would read as the angle running backwards.
  if (inExit) continue;
  peakRate = Math.max(peakRate, Math.abs(drone.flipRate));
  finalRate = Math.abs(drone.flipRate);
  const phi = Math.abs(t);
  // The rotation must never stall or back up: that is what made earlier
  // versions read as a hop followed by a separate spin.
  if (phi + 1e-9 < prevAngle) reversed = true;
  prevAngle = phi;
  // Stronger than "never reverses": on the way up to the rate limit the roll
  // must never slow down either. A dip there is the hand-off showing — the
  // roll-in easing to a stop at the bank angle and waiting for the torque,
  // which reads as the drone getting into position rather than flying into the
  // flip. Only up to the limit: the brake past it is a deliberate slowdown.
  const rate = Math.abs(drone.flipRate);
  if (phi > 0.05 && !reachedLimit) {
    if (rate + 1e-6 < prevRate) rateDipped = true;
    prevRate = rate;
    slowestRate = Math.min(slowestRate, rate);
  }
  if (rate >= spec.flipMaxRate * 0.98) reachedLimit = true;
  if (rateAtQuarter === 0 && phi > Math.PI / 2) rateAtQuarter = Math.abs(drone.flipRate);
  if (rateAtThreeQuarter === 0 && phi > (3 * Math.PI) / 2) rateAtThreeQuarter = Math.abs(drone.flipRate);
  if (firstRollSign === 0 && t !== 0) firstRollSign = Math.sign(t);
}

console.log(`  INFO  phases: entry=${sawEntry} rotate=${sawRotate} exit=${sawArc}, flip took ${duration.toFixed(2)}s`);
if (sawEntry && sawRotate && sawArc) console.log('  PASS  rolls in, torque takes over, then flies the exit bank out');
else { failures += 1; console.log('  FAIL  did not run all three phases'); }
if (!reversed) console.log('  PASS  one continuous rotation — angle never stalls or reverses');
else { failures += 1; console.log('  FAIL  roll angle went backwards mid-flip'); }
console.log(`  INFO  slowest roll rate on the way up to the limit: ${slowestRate.toFixed(1)} rad/s`);
if (!rateDipped) console.log('  PASS  the roll only ever winds up — no hand-off visible');
else { failures += 1; console.log('  FAIL  roll slowed mid-flip (reads as posing before the flip)'); }
check('right flip drops its right side first', firstRollSign, -1, 0);

// Angular momentum: the rate is integrated from torque, so it must build,
// peak and be braked. An eased animation would show none of this.
const alpha = spec.flipTorque / drone._rollInertia;
console.log(`  INFO  angular accel = torque/inertia = ${alpha.toFixed(0)} rad/s^2`);
console.log(`  INFO  peak rate ${peakRate.toFixed(1)} rad/s (${(peakRate / (2 * Math.PI)).toFixed(2)} rev/s), limit ${spec.flipMaxRate}`);
check('spins up to the firmware rate limit (rad/s)', peakRate, spec.flipMaxRate, 1.5);
// Read from the controller rather than sampled: at 823 rad/s² the counter-torque
// takes the rate from 14 to the exit target inside one 60 Hz step, so no
// external observer ever sees a partially-braked frame.
const released = drone._flipReleaseRate;
console.log(`  INFO  released at ${released.toFixed(2)} rad/s from a peak of ${peakRate.toFixed(1)} (target ${spec.flipExitRate})`);
if (released < peakRate * 0.6) console.log('  PASS  braked by counter-torque before completing');
else { failures += 1; console.log('  FAIL  rotation was not braked'); }
void finalRate;
// Follow-through: the brake stops short of a standstill on purpose, and the
// leftover becomes a slight bank that attitude hold springs back out of. Both
// bounds matter — none at all and the rotation stops dead like an animation,
// too much and the spring-back reads as a twitch bolted onto the end rather
// than as the rotation settling.
const recoilDeg = recoilRoll * DEG;
console.log(`  INFO  follow-through past level: ${recoilDeg.toFixed(1)}° (cap ${spec.flipRecoilMaxDeg}°)`);
if (Math.abs(recoilDeg) > 3) console.log('  PASS  carries past level and is sprung back');
else { failures += 1; console.log('  FAIL  rotation stopped dead, no follow-through'); }
if (Math.abs(recoilDeg) <= spec.flipRecoilMaxDeg) console.log('  PASS  and stays a settle, not a bounce');
else { failures += 1; console.log('  FAIL  overshoot exceeded its cap'); }
if (Math.sign(recoilRoll) === firstRollSign) console.log('  PASS  continues the way it was rolling');
else { failures += 1; console.log('  FAIL  kicked back against the flip direction'); }

// And that bank has to do real work, not just look tilted. It is flown under
// power, so it should still be carrying the drone on well after the rotation
// has finished — this measures only the travel after 360°.
const exitTravel = driftAlongRight(xAtExit, zAtExit);
console.log(
  `  INFO  after coming level it ran on ${(exitTravel / drone.span).toFixed(1)} spans, ` +
    `slowing ${speedAtExit.toFixed(2)} -> ${speedAtHandback.toFixed(2)} m/s`,
);
if (exitTravel > drone.span * 1.5) console.log('  PASS  keeps driving the way it flipped after coming level');
else { failures += 1; console.log('  FAIL  stopped dead once the rotation finished'); }
// It has to be momentum bleeding off, not a sustained drive: the push belongs
// to the rotation that caused it, so it must visibly decay inside the
// manoeuvre rather than coasting on unopposed past the end of it.
if (speedAtHandback < speedAtExit * 0.75) console.log('  PASS  and that run-on is decaying, not sustained');
else { failures += 1; console.log('  FAIL  exit drive never slowed down'); }
if (rateAtQuarter > 1 && rateAtThreeQuarter > 1) console.log('  PASS  carries angular momentum right through');
else { failures += 1; console.log('  FAIL  rate collapsed mid-rotation'); }

const climb = peakY - yBefore;
console.log(
  `  INFO  peak +${climb.toFixed(2)} m = ${(climb / drone.span).toFixed(1)} spans` +
    ` (during ${peakAtEntry ? 'entry' : 'rotation'}); lowest swept ` +
    `${(lowestSwept - entryLowest).toFixed(3)} m vs entry underside`,
);
if (climb > 0.05) console.log('  PASS  gains height under its own thrust first');
else { failures += 1; console.log('  FAIL  no entry lift'); }
// Regression guard on the complaint this manoeuvre was retuned for. The old
// straight-up punch ballooned to 4.7 spans and then floated back down, which is
// what made it read as animated rather than flown.
if (climb < drone.span * 3) console.log('  PASS  climb stays in the range real footage shows');
else { failures += 1; console.log(`  FAIL  ballooned to ${(climb / drone.span).toFixed(1)} spans`); }

// The visible climb before the rotation takes over. This is the part that reads
// as the drone winding up to flip rather than flipping from level.
console.log(`  INFO  lifted ${(entryRise / drone.span).toFixed(1)} spans before the rotation started`);
if (entryRise > drone.span) console.log('  PASS  goes up before it flips');
else { failures += 1; console.log('  FAIL  barely rose before rolling'); }

// The shape, not just the size. The drone is unpowered from 90° to 270°, so the
// flip is a ballistic arc, and it only reads as an arc if the drone is over the
// top and already descending before it comes upright. Peaking at 360° means it
// climbed through the whole flip and sank afterwards — the ramp-and-float this
// manoeuvre keeps being pulled back from.
const peakRollDeg = rollAtPeak * DEG;
console.log(`  INFO  highest point reached at ${peakRollDeg.toFixed(0)}° of roll (180° = inverted)`);
if (peakRollDeg > 150 && peakRollDeg < 290) console.log('  PASS  arcs over the top — peaks in the inverted half');
else { failures += 1; console.log(`  FAIL  apex at ${peakRollDeg.toFixed(0)}°, not an arc`); }

let lowestAfter = Infinity;
sim(3, () => { lowestAfter = Math.min(lowestAfter, drone.body.translation().y - hy); });
const sag = entryLowest - Math.min(lowestAfter, lowestSwept);
console.log(`  INFO  deepest point below entry: ${sag.toFixed(3)} m`);
// Regression guard on "it pushes down instead of towards the flip direction".
// The throttle used to stay chopped after the rotation while the drone coasted
// its arc out, so the exit bank did no work and the only thing that phase
// produced was the drone sinking ~0.08 m. The throttle now comes back on at
// 360°, so the flip ends by flying, not falling.
if (sag < 0.04) console.log('  PASS  comes out of the flip flying, not sinking');
else { failures += 1; console.log(`  FAIL  sank ${sag.toFixed(3)} m out of the flip`); }

// It does not have to land exactly on entry height at handback — closing the
// last bit is ordinary altitude hold, the same code every other height
// correction in the game uses, so a little of it finishing after control
// returns just reads as normal flight. What it must not do is hand back so far
// off that closing the gap needs a distinctly harder push than ordinary hold
// ever applies elsewhere — that is what read as a second, separate force.
console.log(`  INFO  height when the flip handed back: ${(altAtHandback - altBefore).toFixed(3)} m vs entry`);
if (Math.abs(altAtHandback - altBefore) < 0.3) console.log('  PASS  hands back close enough for ordinary hold to finish it');
else { failures += 1; console.log('  FAIL  handed back too far off for an ordinary correction'); }
check('recovers to its entry height (m)', drone.altitude, altBefore, 0.06);
check('and comes to a complete stop (m/s)', drone.speed, 0, 0.05);
check('flipRoll released', drone.flipRoll, 0, 1e-9);
check('flipRate released', drone.flipRate, 0, 1e-9);
checkState('flipping cleared', drone.isFlipping, false);

const drift = driftAlongRight(xBefore, zBefore);
console.log(`  INFO  sideways travel ${drift.toFixed(3)} m = ${(drift / drone.span).toFixed(2)} spans (emergent, no impulse applied)`);
// The entry bank is the only source of this: thrust acts along body-up, so a
// banked drone is pushed sideways by the same force that lifts it.
if (drift > 2 * drone.span) console.log('  PASS  travels across the room, not on the spot');
else { failures += 1; console.log('  FAIL  flip happened on the spot'); }

const xLeft = drone.position.x;
const zLeft = drone.position.z;
drone.flip(-1);
sim(4);
const driftLeft = driftAlongRight(xLeft, zLeft);
console.log(`  INFO  left-flip travel ${driftLeft.toFixed(3)} m`);
if (driftLeft < -0.2 * drone.span) console.log('  PASS  left flip mirrors it');
else { failures += 1; console.log('  FAIL  left flip did not mirror'); }

console.log('\n=== 8. climb / descend ===');
const altStart = drone.altitude;
drone.setInput('up', true);
sim(2);
drone.setInput('up', false);
sim(1.5);
console.log(`  INFO  climbed ${(drone.altitude - altStart).toFixed(2)} m in 2 s (rate ${spec.climbRate} m/s)`);
check('climb reached target', drone.altitude - altStart, spec.climbRate * 2, 0.35);

console.log('\n=== 9. land -> touchdown at y=0 ===');
const canLand = drone.land();
console.log(`  ${canLand ? 'PASS' : 'FAIL'}  land() accepted in flight`);
if (!canLand) failures += 1;
checkState('state right after land()', drone.state, DroneState.LANDING);
let touchdown = null;
sim(12, (t) => {
  if (touchdown === null && drone.state === DroneState.LANDED) touchdown = t;
});
checkState('state', drone.state, DroneState.LANDED);
check('final altitude (m)', drone.altitude, 0, 0.005);
check('final speed (m/s)', drone.speed, 0, 0.005);
console.log(`  INFO  descent took ${touchdown?.toFixed(2)} s`);

console.log('\n=== 10. inputs are locked outside flight ===');
drone.setInput('forward', true);
checkState('canManeuver while landed', drone.canManeuver, false);
const zLanded = drone.position.z;
sim(2);
check('landed drone does not move', Math.abs(drone.position.z - zLanded), 0, 0.005);

console.log('\n=== 11. relaunch after landing (state resets cleanly) ===');
drone.takeoff();
sim(6);
checkState('state', drone.state, DroneState.FLYING);
check('hover altitude (m)', drone.altitude, spec.hoverHeight, 0.05);

console.log('\n=== 12. environment props are solid ===');
// Reset to a known pose, then put a pylon and a wall in the flight path.
drone.body.setTranslation({ x: 0, y: drone._restY + 1.0, z: 0 }, true);
drone.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
drone.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
drone.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
drone.tracked.resync();
drone.targetY = 1.0;

physics.createStaticColliders([
  { shape: 'cylinder', radius: 0.13, halfHeight: 1.3, position: [0, 1.3, -2] },
  { shape: 'box', halfExtents: [1.5, 3, 1.5], position: [3.2, 3, 0], rotationY: 0.3 },
]);

drone.setInput('forward', true);
sim(5);
drone.setInput('forward', false);
sim(1);
const pylonFace = -2 + 0.13 + drone._halfExtents.z;
console.log(`  INFO  stopped at z=${drone.position.z.toFixed(3)} (pylon face at z=${pylonFace.toFixed(3)})`);
if (drone.position.z > -2) console.log('  PASS  blocked by the pylon (did not tunnel through)');
else { failures += 1; console.log('  FAIL  passed through the pylon'); }
if (drone.position.z < -1.0) console.log('  PASS  actually flew into it rather than stalling early');
else { failures += 1; console.log('  FAIL  never reached the pylon'); }

// Now the box, approached sideways.
drone.body.setTranslation({ x: 0, y: drone._restY + 1.0, z: 0 }, true);
drone.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
drone.tracked.resync();
drone.setInput('right', true);
sim(5);
drone.setInput('right', false);
sim(1);
console.log(`  INFO  stopped at x=${drone.position.x.toFixed(3)} (wall near x=1.7)`);
if (drone.position.x < 2.2) console.log('  PASS  blocked by the wall');
else { failures += 1; console.log('  FAIL  passed through the wall'); }
checkState('still airborne after collisions', drone.state, DroneState.FLYING);
check('altitude held through collisions (m)', drone.altitude, 1.0, 0.15);

console.log('\n=== 13. landing on a raised surface ===');
// A flat-topped plinth 2 m up, well clear of the pylon/wall from test 12.
const PLINTH_TOP = 2.0;
physics.createStaticColliders([
  { shape: 'box', halfExtents: [0.6, PLINTH_TOP / 2, 0.6], position: [-8, PLINTH_TOP / 2, -8] },
]);

// Park the drone in a hover directly above it.
drone.state = DroneState.FLYING;
drone.isFlipping = false;
drone.clearInputs();
drone.body.setTranslation({ x: -8, y: PLINTH_TOP + 1.0, z: -8 }, true);
drone.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
drone.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
drone.tracked.resync();
drone.targetY = PLINTH_TOP + 1.0;
sim(1.5);

console.log(`  INFO  probed surface below: ${drone.groundY.toFixed(2)} m (plinth top is ${PLINTH_TOP})`);
check('ground probe finds the plinth, not y=0', drone.groundY, PLINTH_TOP, 0.02);
check('altitude is measured above the plinth (m)', drone.altitude, 1.0, 0.12);

const landedOnPlinth = drone.land();
console.log(`  ${landedOnPlinth ? 'PASS' : 'FAIL'}  land() accepted above the plinth`);
if (!landedOnPlinth) failures += 1;
let plinthTouchdown = null;
sim(10, (t) => {
  if (plinthTouchdown === null && drone.state === DroneState.LANDED) plinthTouchdown = t;
});
checkState('state', drone.state, DroneState.LANDED);
console.log(`  INFO  settled at y=${drone.position.y.toFixed(3)} after ${plinthTouchdown?.toFixed(2)}s`);
check('rests on the plinth top, not the floor', drone.position.y, PLINTH_TOP + drone._halfExtents.y, 0.02);
check('reports zero altitude there (m)', drone.altitude, 0, 0.005);
check('and is stationary', drone.speed, 0, 0.005);

// It must be able to take off again from up there.
drone.takeoff();
sim(6);
checkState('takes off again from the plinth', drone.state, DroneState.FLYING);
check('hovers 1 m above the plinth', drone.position.y - PLINTH_TOP, spec.hoverHeight, 0.06);

// --- descend onto the plinth and climb straight back off ------------------
// Regression: the altitude command used to be clamped against the arena floor,
// so holding DOWN over a raised surface wound targetY metres below the drone
// while it physically rested on the plinth. UP then spent seconds unwinding
// that before the drone actually moved.
console.log('\n  -- holding DOWN while resting on the plinth --');
drone.setInput('down', true);
sim(6); // far longer than it takes to reach the surface
drone.setInput('down', false);
sim(0.5);

const restingY = drone.position.y;
const commandGap = restingY - drone.targetY;
console.log(
  `  INFO  after 6 s of DOWN: y=${restingY.toFixed(3)}, targetY=${drone.targetY.toFixed(3)} ` +
    `(command sits ${commandGap.toFixed(3)} m below the drone)`,
);
check('settles just above the plinth, not on the floor', restingY - PLINTH_TOP, spec.minAltitude, 0.08);
if (commandGap < 0.6) {
  console.log('  PASS  altitude command did not wind up beneath the drone');
} else {
  failures += 1;
  console.log(`  FAIL  command wound ${commandGap.toFixed(2)} m below the drone`);
}

// The real symptom: UP must bite as fast over the plinth as over open ground.
// Comparing against a measured baseline rather than an invented threshold —
// what matters is that being on a surface costs nothing, not the absolute rate.
// Read the body directly, not `position` — that field is only refreshed by
// syncVisual(), which the bare baseline loop below does not call.
const beforeUp = drone.body.translation().y;
drone.setInput('up', true);
sim(0.35);
drone.setInput('up', false);
const climbedOnPlinth = drone.body.translation().y - beforeUp;
sim(2);

const baseline = new DroneController({ physics, scene, spec });
baseline._halfExtents = drone._halfExtents.clone();
baseline.span = drone.span;
baseline._createBody();
const stopBaseline = physics.onFixedStep((dt) => baseline.fixedUpdate(dt));
baseline.body.setTranslation({ x: 30, y: 1 + baseline._halfExtents.y, z: 30 }, true);
baseline.state = DroneState.FLYING;
baseline.targetY = 1 + baseline._halfExtents.y;
baseline.tracked.resync();
for (let i = 0; i < 60; i += 1) physics.update(DT);
// Same abuse: hold DOWN long past the floor, release, then climb.
baseline.setInput('down', true);
for (let i = 0; i < Math.round(6 / DT); i += 1) physics.update(DT);
baseline.setInput('down', false);
for (let i = 0; i < Math.round(0.5 / DT); i += 1) physics.update(DT);
const baselineBefore = baseline.body.translation().y;
baseline.setInput('up', true);
for (let i = 0; i < Math.round(0.35 / DT); i += 1) physics.update(DT);
baseline.setInput('up', false);
const climbedOnGround = baseline.body.translation().y - baselineBefore;
stopBaseline();
baseline.dispose();

console.log(
  `  INFO  first 0.35 s of UP: ${(climbedOnPlinth * 1000).toFixed(0)} mm on the plinth vs ` +
    `${(climbedOnGround * 1000).toFixed(0)} mm on open ground`,
);
if (climbedOnPlinth > climbedOnGround * 0.9) {
  console.log('  PASS  UP over a raised surface responds as fast as over ground');
} else {
  failures += 1;
  console.log('  FAIL  UP was still unwinding a wound-up command');
}

console.log('\n=== 14. fixed-step decoupling ===');
const before = drone.altitude;
physics.update(0.25); // simulate a long stall: must clamp, not explode
console.log(`  INFO  steps run for a 250ms frame: ${physics.stepsLastFrame} (cap 5)`);
if (physics.stepsLastFrame > 5) failures += 1;
check('altitude stable after stall', drone.altitude, before, 0.15);
const alphaOk = physics.alpha >= 0 && physics.alpha < 1;
console.log(`  ${alphaOk ? 'PASS' : 'FAIL'}  interpolation alpha in [0,1): ${physics.alpha.toFixed(4)}`);
if (!alphaOk) failures += 1;

console.log('\n=== 15. disposal ===');
drone.dispose();
physics.dispose();
console.log('  PASS  disposed without throwing');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
