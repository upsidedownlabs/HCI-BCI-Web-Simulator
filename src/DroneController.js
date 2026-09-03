/**
 * Drone flight model, state machine and model binding.
 *
 * Flight model
 * ------------
 * The rigid body's rotation is locked to the Y axis. Yaw is genuinely
 * simulated: a torque-based rate controller drives `angvel().y`.
 *
 * Pitch and roll are a *commanded attitude* rather than free rotation, which is
 * how an attitude-stabilised multirotor actually behaves — the flight
 * controller holds the requested lean and the airframe never tumbles. That
 * commanded attitude does real work: the thrust vector is rotated by it, so
 * leaning 15° forward produces a horizontal force of `thrust · sin(15°)` and
 * the drone accelerates. The visual tilt the user sees and the force driving
 * the body are the same quantity, not a cosmetic overlay.
 *
 * Consequences worth knowing:
 *  - Top speed falls out of the physics as `g · tan(maxTilt) / linearDamping`
 *    rather than being clamped by hand.
 *  - The drone cannot be flipped over by a collision, which is the correct
 *    behaviour for a Tello-class toy drone with self-levelling enabled.
 *
 * Model swapping
 * --------------
 * `spec.modelPath` is the only thing that must change for a different airframe.
 * The mesh is uniformly rescaled to `spec.targetSpan`, recentred on its own
 * bounding box, and the collider half-extents are derived from that box — so
 * no physics constants are tied to a particular GLB.
 */
import * as THREE from 'three';
import { RAPIER } from './Physics.js';
import { disposeObject3D } from './Scene.js';
import { WORLD } from './config.js';

/** @enum {string} */
export const DroneState = {
  LANDED: 'landed',
  TAKING_OFF: 'takingOff',
  FLYING: 'flying',
  LANDING: 'landing',
};

/** Movement commands accepted by `setInput`. */
export const INPUTS = [
  'forward',
  'backward',
  'left',
  'right',
  'up',
  'down',
  'yawLeft',
  'yawRight',
];

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const ROLL_AXIS = new THREE.Vector3(0, 0, 1);
const TWO_PI = Math.PI * 2;
/** Rotor hubs spin about their own local Y (verified against the Tello's rig). */
const SPIN_AXIS = new THREE.Vector3(0, 1, 0);
/** How far down to look for a landing surface, metres. */
const GROUND_PROBE_RANGE = 60;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Smoothstep — zero derivative at both ends, so flips start and stop cleanly. */
const smoothstep = (t) => t * t * (3 - 2 * t);

export class DroneController {
  /**
   * @param {object} opts
   * @param {import('./Physics.js').PhysicsWorld} opts.physics
   * @param {THREE.Scene} opts.scene
   * @param {import('./config.js').DroneSpec} opts.spec
   */
  constructor({ physics, scene, spec, spawn }) {
    this.physics = physics;
    this.scene = scene;
    this.spec = spec;
    /** World point to start from — the environment picks flat ground for it. */
    this.spawnPoint = spawn ? spawn.clone() : new THREE.Vector3();

    this.state = DroneState.LANDED;
    this.isFlipping = false;

    /** @type {Record<string, boolean>} */
    this.input = Object.fromEntries(INPUTS.map((k) => [k, false]));

    // Commanded attitude, radians. Smoothed toward the stick target each step.
    this.pitch = 0;
    this.roll = 0;
    this.flipRoll = 0;
    this._flipTime = 0;
    this._flipDirection = 1;

    /** Commanded world-space Y for the body centre. Absolute rather than AGL,
     *  so flying over a pillar doesn't make the drone climb to clear it. */
    this.targetY = 0;
    /** Surface height directly beneath the drone, re-probed every step. */
    this.groundY = WORLD.groundY;
    /** Height above that surface — drives takeoff, landing and the HUD. */
    this.altitude = 0;
    this.speed = 0;
    this.yaw = 0;
    this._y = 0;
    this._hoverTimer = 0;
    this._rotorPhase = 0;
    /** Eased 0..n rotor rate, so the props spool up and down rather than snap. */
    this._rotorSpeed = 0;
    this._spinQuat = new THREE.Quaternion();
    this._thrustRatio = 0;

    // Scene graph:
    //   root      physics transform + commanded tilt
    //   flipPivot carries the flip roll about the airframe's centre
    //   pivot     per-model orientation fixes
    this.root = new THREE.Group();
    this.root.name = 'drone';
    this.flipPivot = new THREE.Group();
    this.pivot = new THREE.Group();
    this.root.add(this.flipPivot);
    this.flipPivot.add(this.pivot);

    this.position = new THREE.Vector3();
    this._bodyQuat = new THREE.Quaternion(); // exact, read during fixed steps
    this._renderQuat = new THREE.Quaternion(); // interpolated, render only
    this._tiltQuat = new THREE.Quaternion();
    this._flipQuat = new THREE.Quaternion();
    this._attitude = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._thrustVector = new THREE.Vector3();
    this._rotors = [];

    this._unsubscribe = null;
    this._model = null;
  }

  // ---------------------------------------------------------------- loading

  /**
   * @param {import('./Loaders.js').AssetLoader} loader
   * @param {(fraction:number)=>void} [onProgress]
   */
  async load(loader, onProgress) {
    const gltf = await loader.loadGLTF(this.spec.modelPath, onProgress);
    const model = gltf.scene;

    // --- normalise: uniform scale to targetSpan, recentre on the bbox -------
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) || 1;
    const scale = this.spec.targetSpan / span;
    model.scale.setScalar(scale);

    const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
    model.position.sub(center);

    this.pivot.rotation.y = (this.spec.modelYawOffsetDeg ?? 0) * DEG;

    model.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = false;
      obj.frustumCulled = true;
    });

    this._bindRotors(gltf, model);

    this.pivot.add(model);
    this.scene.add(this.root);
    this._model = model;

    // Collider from the scaled bounding box — swapping models resizes it
    // automatically, no constants to update.
    this._halfExtents = size.multiplyScalar(scale * 0.5);
    this._halfExtents.y = Math.max(this._halfExtents.y, 0.015);
    /** Measured span in metres; drives camera framing and pad size. */
    this.span = Math.max(this._halfExtents.x, this._halfExtents.z) * 2;

    this._createBody();
    this._unsubscribe = this.physics.onFixedStep((dt) => this.fixedUpdate(dt));
    return this;
  }

  /**
   * Rotor animation, in order of preference:
   *  1. procedural spin of name-matched nodes — continuous by construction;
   *  2. the GLB's own clips, if `useModelAnimation` is set and the model has
   *     a clip that genuinely loops.
   *
   * The stock Tello's clip is *not* such a clip: it is a 6.4 s spin-up/spin-down
   * ramp (11°/s rising to 870°/s and back) with a 90° discontinuity at the loop
   * seam, so playing it looks like the props repeatedly starting and stopping.
   * Its quaternion keys are also baked at 25 Hz with LINEAR interpolation, which
   * aliases once the blades exceed 180° between keys. Hence procedural first.
   */
  _bindRotors(gltf, model) {
    if (this.spec.rotorNodePattern) {
      const pattern = new RegExp(this.spec.rotorNodePattern, 'i');
      model.traverse((obj) => {
        if (obj !== model && pattern.test(obj.name)) {
          // Keep the authored transform and spin about the hub's own Y axis,
          // so pre-rotated hubs aren't snapped to a new orientation.
          this._rotors.push({ node: obj, baseQuat: obj.quaternion.clone() });
        }
      });
      if (this._rotors.length) return;
    }

    if (this.spec.useModelAnimation && gltf.animations?.length) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) this.mixer.clipAction(clip).play();
    }
  }

  _createBody() {
    const { spec, physics } = this;
    const h = this._halfExtents;
    this.groundY = this.spawnPoint.y;
    this._restY = this.spawnPoint.y + h.y;
    this.targetY = this._restY;
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.spawnPoint.x, this._restY, this.spawnPoint.z)
        .setLinearDamping(spec.linearDamping)
        .setAngularDamping(spec.angularDamping)
        .setCanSleep(false),
    );
    // Self-levelling: only yaw is free.
    this.body.setEnabledRotations(false, true, false, true);

    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setMass(spec.mass)
        .setFriction(1.2)
        .setRestitution(0.05),
      this.body,
    );

    // Yaw inertia of the equivalent box, used to size the torque controller so
    // response is identical regardless of the airframe's mass or footprint.
    const w = h.x * 2;
    const d = h.z * 2;
    this._yawInertia = (spec.mass * (w * w + d * d)) / 12;
    // Roll is about the body's forward axis, so it is the width and height that
    // resist it. Derived from the airframe, so a heavier or wider drone flips
    // more slowly for the same rotor torque without any constant being retuned.
    // Scaled down because a quad is not a solid slab: see `rollInertiaFactor`.
    const t = h.y * 2;
    this._rollInertia = ((spec.mass * (w * w + t * t)) / 12) * (spec.rollInertiaFactor ?? 1);

    this.tracked = physics.track(this.body);
    this.position.copy(this.tracked.position);
  }

  // ------------------------------------------------------------------ input

  /** @param {(typeof INPUTS)[number]} command */
  setInput(command, active) {
    if (command in this.input) this.input[command] = Boolean(active);
  }

  clearInputs() {
    for (const key of INPUTS) this.input[key] = false;
  }

  /** True only in steady flight — takeoff, landing and flips lock out the sticks. */
  get canManeuver() {
    return this.state === DroneState.FLYING && !this.isFlipping;
  }

  takeoff() {
    if (this.state !== DroneState.LANDED) return false;
    this.clearInputs();
    this.state = DroneState.TAKING_OFF;
    // Ramp from wherever it is resting — the arena floor or a pillar top.
    this.targetY = this._restY;
    this._hoverTimer = 0;
    return true;
  }

  land() {
    if (this.state !== DroneState.FLYING || this.isFlipping) return false;
    this.clearInputs();
    this.state = DroneState.LANDING;
    this.targetY = this._y;
    return true;
  }

  /**
   * Flip, flown rather than animated.
   *
   * One continuous rotation from 0 to 360 degrees, in two phases that differ
   * only in what is driving it:
   *
   *  1. **Entry** — the pilot rolls in with the throttle up. The roll is a
   *     commanded attitude, tracked at the airframe's own tilt response, and
   *     the throttle is full. Because `_applyThrust` steers thrust along the
   *     rolled body-up axis, that single force does both jobs at once: its
   *     vertical part is the height the flip is about to spend, its horizontal
   *     part is the sideways travel. Leaning harder trades one for the other,
   *     which is why a real flip moves across the room without ballooning.
   *  2. **Rotate** — past the entry angle the roll rate is beyond what attitude
   *     hold will track, so differential rotor thrust takes over as a torque.
   *     `_updateFlip` integrates τ/I into angular velocity and that into angle,
   *     picking up the rate the entry left behind, so the drone spins up,
   *     coasts at the firmware limit, and is braked by counter-torque. Throttle
   *     follows cos(roll) and cuts out past 90 degrees — rotors can only push
   *     along body-up, and pushing while inverted would drive it into the
   *     ground — so the inverted half is genuinely ballistic.
   *
   * Nothing about the path is authored: the arc, the altitude loss and the
   * sideways travel all fall out of the forces. The angle never stalls or
   * reverses, so it reads as one movement rather than a hop and a spin.
   *
   * @param {1|-1} direction +1 = roll right, -1 = roll left
   */
  flip(direction) {
    if (!this.canManeuver) return false;
    const dir = direction >= 0 ? 1 : -1;

    this.clearInputs();
    this.isFlipping = true;
    this._flipDirection = dir;
    this._flipPhase = 'entry';
    this._flipTime = 0;
    this.flipRoll = 0;
    /** Angular velocity about the roll axis, rad/s — integrated, not scripted. */
    this.flipRate = 0;
    this._flipBraking = false;
    this._flipBrakeDecel = 0;
    // Height the recovery aims back at.
    this._flipBaseY = this._y;
    return true;
  }





  // ------------------------------------------------------------- simulation

  /** Runs at a fixed 60 Hz from PhysicsWorld. @param {number} dt */
  fixedUpdate(dt) {
    const { body, spec } = this;
    if (!body) return;

    // Rapier accumulates user forces until explicitly cleared.
    body.resetForces(false);
    body.resetTorques(false);

    const t = body.translation();
    const v = body.linvel();
    const r = body.rotation();
    this._bodyQuat.set(r.x, r.y, r.z, r.w);
    // Rotation is Y-locked, so the quaternion reduces to a pure heading.
    this._physicsYaw = Math.atan2(2 * r.w * r.y, 1 - 2 * r.y * r.y);

    // Landing surface first: everything below is measured against it, so the
    // drone can set down on a pillar top rather than only on y = 0.
    this.groundY = this._probeGround(t);
    this._restY = this.groundY + this._halfExtents.y;
    this._y = t.y;
    this.altitude = Math.max(0, t.y - this._restY);
    this.speed = Math.hypot(v.x, v.z);

    this._updateFlip(dt);
    this._updateAttitude(dt, v);
    this._updateYaw(dt);
    this._updateStateMachine(dt, v);
    this._applyThrust(v);
    this._containWithinArena(t, v);
  }

  /** Exponential smoothing toward the commanded lean, frame-rate independent. */
  _updateAttitude(dt, v) {
    const spec = this.spec;
    const maxTilt = spec.maxTiltDeg * DEG;
    let pitchTarget = 0;
    let rollTarget = 0;

    // The exit splits in two. For `flipKickTime` the bank left by the rotation
    // is allowed to drive the drone unopposed — that is the throw out of the
    // flip, and it lands on the moment the roll completes. After that the
    // ordinary auto-brake takes over even though the manoeuvre is still
    // running, so the drone visibly decelerates instead of coasting on for
    // half a second. A push that outlives the rotation by that much stops
    // reading as something the rotation caused.
    const kicking =
      this._flipPhase !== 'exit' || this._flipTime < this.spec.flipKickTime;

    if (this.isFlipping && kicking) {
      // `flipRoll` owns the attitude for the whole manoeuvre, entry included —
      // the entry bank is the first few tens of degrees of the same rotation,
      // not a separate lean layered underneath it. Adding one here would make
      // the visible roll jump when the torque takes over.
      // Inputs are cleared for the duration of a flip, so once this stops being
      // true the branch below lands on its auto-brake case.
    } else if (this.canManeuver || this.isFlipping) {
      const fwd = (this.input.forward ? 1 : 0) - (this.input.backward ? 1 : 0);
      const rgt = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);

      if (fwd === 0 && rgt === 0) {
        // Sticks centred: lean against the drift to brake. Same mechanism as
        // normal flight — the tilt steers the thrust vector — just aimed
        // opposite the current velocity.
        const sin = Math.sin(this._physicsYaw);
        const cos = Math.cos(this._physicsYaw);
        const alongForward = -v.x * sin - v.z * cos;
        const alongRight = v.x * cos - v.z * sin;

        const gain = spec.brakeGainDegPerMs * DEG;
        const limit = spec.maxBrakeDeg * DEG;
        pitchTarget = clamp(alongForward * gain, -limit, limit);
        rollTarget = clamp(alongRight * gain, -limit, limit);
      } else {
        // Nose-down is negative pitch about +X; banking right is negative roll
        // about +Z. Both signs are what make the thrust vector push the way the
        // user expects — see _applyThrust.
        pitchTarget = -fwd * maxTilt;
        rollTarget = -rgt * maxTilt;
      }
    }

    const k = 1 - Math.exp(-dt / spec.tiltResponse);
    this.pitch += (pitchTarget - this.pitch) * k;
    this.roll += (rollTarget - this.roll) * k;
  }

  /** Torque-driven yaw rate controller with damping feed-forward. */
  _updateYaw(dt) {
    const cmd = this.canManeuver
      ? (this.input.yawLeft ? 1 : 0) - (this.input.yawRight ? 1 : 0)
      : 0;
    const desiredRate = cmd * this.spec.yawRateDeg * DEG;
    const error = desiredRate - this.body.angvel().y;

    // Feed-forward cancels Rapier's angular damping so the commanded rate is
    // actually reached instead of settling short of it.
    const torque =
      this._yawInertia * (error / this.spec.yawResponse + desiredRate * this.spec.angularDamping);
    this.body.addTorque({ x: 0, y: torque, z: 0 }, true);
    void dt;
  }

  _updateStateMachine(dt, v) {
    const spec = this.spec;

    switch (this.state) {
      case DroneState.LANDED:
        this.targetY = this._restY;
        // Safe to freeze because _settleOnGround snapped us flush to the pad —
        // zeroing velocity while still airborne would leave the drone stuck.
        // The altitude guard covers the surface it landed on vanishing.
        if (
          this.altitude <= spec.touchdownHeight * 4 &&
          (this.speed > 0.001 || Math.abs(v.y) > 0.001)
        ) {
          this.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        }
        break;

      case DroneState.TAKING_OFF:
        this.targetY = Math.min(
          this.targetY + spec.takeoffClimbRate * dt,
          this._restY + spec.hoverHeight,
        );
        if (
          Math.abs(this.altitude - spec.hoverHeight) < spec.hoverTolerance &&
          Math.abs(v.y) < 0.25
        ) {
          this._hoverTimer += dt;
          if (this._hoverTimer >= spec.hoverSettleTime) {
            this.state = DroneState.FLYING;
            this.targetY = this._restY + spec.hoverHeight;
            this._hoverTimer = 0;
          }
        } else {
          this._hoverTimer = 0;
        }
        break;

      case DroneState.FLYING: {
        if (this.isFlipping) break; // the flip owns thrust and attitude
        const climb = (this.input.up ? 1 : 0) - (this.input.down ? 1 : 0);
        const floor = WORLD.groundY + this._halfExtents.y;

        // Minimum height is measured above whatever is actually underneath, not
        // above the arena floor. Referenced to the floor, DOWN over a rooftop
        // would keep integrating the command downward while the drone
        // physically rested on it — metres of wound-up command that a later UP
        // has to unwind before anything visibly moves.
        this.targetY = clamp(
          this.targetY + climb * spec.climbRate * dt,
          this._restY + spec.minAltitude,
          floor + spec.maxAltitude,
        );

        // Note: there is deliberately no second "never let the command sit far
        // below the airframe" guard here. The probe-based lower bound above
        // already prevents the windup it was added for, and as a running
        // max() it ratchets — a flip leaves the drone high, vertical velocity
        // passes through zero at the apex, and the target gets dragged up and
        // never settles back.
        break;
      }

      case DroneState.LANDING:
        // Commanding below the detected surface guarantees firm contact instead
        // of asymptotically approaching it.
        this.targetY = Math.max(this.targetY - spec.landingDescentRate * dt, this._restY - 0.2);
        if (this.altitude <= spec.touchdownHeight && Math.abs(v.y) < 0.35) {
          this._settleOnGround();
        }
        break;
    }
  }

  /**
   * Thrust always acts along the airframe's own up axis — that is the only
   * direction rotors can push.
   *
   * In normal flight the commanded lean steers that axis, which is what turns a
   * 15 degree bank into horizontal acceleration. During a flip the axis is
   * swept all the way around by `flipRoll`, so the same code produces the real
   * consequences: it pushes sideways at 90 degrees and would push the drone
   * *downward* while inverted. Firmware cuts throttle past 90 degrees rather
   * than doing that, so the inverted half is genuinely ballistic — which is
   * where a real flip's altitude loss comes from.
   */
  _applyThrust(v) {
    const spec = this.spec;

    if (this.state === DroneState.LANDED) {
      this._thrustRatio = 0;
      return;
    }

    const maxThrust = spec.mass * WORLD.gravity * spec.maxThrustG;

    this._euler.set(this.pitch, 0, this.roll, 'YXZ');
    this._tiltQuat.setFromEuler(this._euler);
    this._attitude.copy(this._bodyQuat).multiply(this._tiltQuat);
    if (this.flipRoll !== 0) {
      this._flipQuat.setFromAxisAngle(ROLL_AXIS, this.flipRoll);
      this._attitude.multiply(this._flipQuat);
    }
    const axis = this._thrustVector.copy(UP).applyQuaternion(this._attitude);

    let magnitude;
    if (this.isFlipping && this._flipPhase !== 'exit') {
      // Full throttle through the entry roll, then modulated by how upright the
      // airframe still is and cut entirely once past 90 degrees. The entry is
      // already banked, so "full throttle" there is not full *lift* — the axis
      // it acts along is doing the sideways work as well.
      const upright = Math.max(0, Math.cos(this.flipRoll));
      magnitude = this._flipPhase === 'entry' ? maxThrust : maxThrust * upright;
    } else {
      // Also the flip's exit phase, deliberately: the throttle comes back on
      // the moment the rotation finishes, so the bank it left behind is flown
      // rather than coasted through — the same ordinary altitude hold used the
      // rest of the time, not a separate controller. A dedicated "snap back to
      // height fast" gain was tried here and felt exactly like what it was: a
      // second, harsher force taking over right as the kick's momentum faded,
      // rather than one continuous, tapering push. Ordinary hold, acting on an
      // axis still tilted by the recoil lean, already gives a gentle diagonal
      // settle — down and sideways together — without inventing a new law.
      // Cascaded altitude hold: position error -> desired climb rate ->
      // required acceleration -> force along the tilted thrust axis.
      const altError = this.targetY - this._y;
      const desiredVy = clamp(
        altError * spec.altitudeGain,
        -Math.max(spec.landingDescentRate, spec.climbRate),
        spec.climbRate,
      );
      const accel = (desiredVy - v.y) * spec.verticalGain + WORLD.gravity;
      // Compensate for the lean so altitude hold stays correct while banking.
      const compensation = Math.max(0.35, axis.y);
      magnitude = clamp((spec.mass * accel) / compensation, 0, maxThrust);
    }

    this._thrustRatio = magnitude / maxThrust;
    this.body.addForce(axis.multiplyScalar(magnitude), true);
  }

  /**
   * Cast straight down for the first solid surface, ignoring the drone itself.
   * A single centre ray is deliberate: it means half-off a pillar edge reads as
   * "no longer over the pad", which is the behaviour a pilot expects.
   */
  _probeGround(t) {
    this._ray.origin.x = t.x;
    this._ray.origin.y = t.y;
    this._ray.origin.z = t.z;

    const hit = this.physics.world.castRay(
      this._ray,
      GROUND_PROBE_RANGE,
      true,
      undefined,
      undefined,
      undefined,
      this.body,
    );
    return hit ? t.y - hit.timeOfImpact : WORLD.groundY;
  }

  /**
   * Rigid-body rotation about the roll axis: torque -> angular velocity -> angle.
   *
   * The torque profile is bang-bang, which is what flight firmware actually
   * runs: full differential thrust to spin up, coast at the rate limit, then
   * full counter-torque timed so the rotation arrives at 360 degrees with the
   * angular velocity back at zero. Because it is integrated rather than eased
   * along a curve, the drone carries real angular momentum — it cannot stop
   * dead, and the braking distance is set by physics.
   */
  _updateFlip(dt) {
    if (!this.isFlipping) return;
    const spec = this.spec;
    this._flipTime += dt;

    if (this._flipPhase === 'exit') {
      // Rotation done, throttle back on, airframe still banked the way it was
      // rolling. That bank is the whole point of this phase: thrust acts along
      // body-up, so a banked drone under power is driven sideways, and the
      // flip finishes by throwing itself onward rather than sagging.
      //
      // An unpowered coast used to sit here, to let the ballistic arc finish
      // before altitude hold took over. It cost more than it bought — with the
      // throttle chopped the exit bank did no work at all, so the only thing
      // the coast produced was the drone sinking.
      if (this._flipTime >= spec.flipExitTime) {
        this.isFlipping = false;
        this._flipPhase = null;
        this._flipTime = 0;
        this.onFlipComplete?.();
      }
      return;
    }

    if (this._flipPhase === 'entry') {
      // Constant angular acceleration, sized to arrive at the entry bank just
      // as the time runs out.
      //
      // Accelerating rather than easing in is the whole point. An exponential
      // approach to a target angle *decelerates* as it nears it, so the roll
      // visibly settles at the bank angle and waits there for the torque to
      // pick it up — the drone looks like it is getting into position for a
      // flip rather than flying into one. Here the rate only ever increases,
      // and the rotation carries on from whatever it has reached, so the whole
      // manoeuvre is a single roll that starts gently and keeps winding up.
      const entry = spec.flipEntryTiltDeg * DEG;
      const accel = (2 * entry) / (spec.flipEntryTime * spec.flipEntryTime);
      const rate = Math.abs(this.flipRate) + accel * dt;
      const angle = Math.abs(this.flipRoll) + rate * dt;
      this.flipRate = -this._flipDirection * rate;
      this.flipRoll = -this._flipDirection * angle;
      if (this._flipTime >= spec.flipEntryTime) this._flipPhase = 'rotate';
      return;
    }

    // alpha = tau / I, from the airframe's real roll inertia, so a different
    // drone with a different mass or span rotates differently on its own.
    const alpha = spec.flipTorque / this._rollInertia;
    const angle = Math.abs(this.flipRoll);
    const rate = Math.abs(this.flipRate);

    const remaining = TWO_PI - angle;
    // Angle this angular velocity needs in order to bleed down to the exit
    // rate. The flip is braked to that, not to a standstill — the leftover
    // momentum is what recoils out of the manoeuvre.
    const exitRate = spec.flipExitRate;
    const stoppingAngle = Math.max(0, (rate * rate - exitRate * exitRate) / (2 * alpha));

    // Latch the brake one step before it is strictly needed, and size the
    // counter-torque to arrive at 360 degrees at exactly the exit rate.
    // Deciding afresh each step instead lets the rotation re-accelerate the
    // moment braking buys it margin, so it chatters and arrives still spinning
    // at two thirds of peak. Braking early keeps the required torque inside
    // what the rotors can actually make.
    if (!this._flipBraking && remaining - rate * dt <= stoppingAngle) {
      this._flipBraking = true;
      this._flipBrakeDecel =
        (rate * rate - exitRate * exitRate) / (2 * Math.max(remaining, 1e-6));
    }

    let angularAccel;
    if (this._flipBraking) angularAccel = -this._flipBrakeDecel;
    else if (rate < spec.flipMaxRate) angularAccel = alpha; // spin up
    else angularAccel = 0; // coast at the firmware rate limit

    // Clamped at both ends as well as accelerated: one 60 Hz step of 364 rad/s²
    // is 6 rad/s, so without this the discrete step blows past either limit.
    const nextRate = clamp(
      rate + angularAccel * dt,
      this._flipBraking ? exitRate : 0,
      spec.flipMaxRate,
    );
    // Trapezoidal, which is exact under the piecewise-constant torque this
    // controller applies. Taking the end-of-step rate instead loses half a
    // step of angle per step while braking — about 7 degrees over the whole
    // deceleration, left to be snapped away when the flip releases.
    const nextAngle = angle + ((rate + nextRate) / 2) * dt;

    this.flipRate = -this._flipDirection * nextRate;
    this.flipRoll = -this._flipDirection * Math.min(nextAngle, TWO_PI);

    // Done when the rotation completes, or when the brake has taken the rate to
    // zero past the halfway point (the manoeuvre cannot un-rotate itself).
    if (nextAngle >= TWO_PI || (nextRate <= 0 && angle > Math.PI)) {
      // Follow-through: the airframe is still turning as it passes level, so
      // hand that momentum to attitude hold rather than deleting it. Under a
      // first-order lag it carries `rate * tiltResponse` past level before
      // being sprung back, so that is the bank attitude hold inherits — a
      // slight overshoot in the direction it was already rolling.
      this.roll = clamp(
        -this._flipDirection * nextRate * spec.tiltResponse,
        -spec.flipRecoilMaxDeg * DEG,
        spec.flipRecoilMaxDeg * DEG,
      );
      /**
       * Rate the rotation was still carrying when it released, rad/s. At this
       * airframe's roll acceleration the brake finishes inside a single 60 Hz
       * step, so this is not observable by sampling `flipRate` from outside.
       */
      this._flipReleaseRate = nextRate;
      this.flipRoll = 0;
      this.flipRate = 0;
      this._flipBraking = false;
      // Level again, but not done: the exit bank still has to be flown out.
      this._flipPhase = 'exit';
      this._flipTime = 0;
      // Altitude hold resumes from here, with real vertical velocity to arrest.
      this.targetY = this._flipBaseY;
    }
  }

  /**
   * Snap flush to the pad and freeze. Called on touchdown so the LANDED state
   * can safely zero velocity without stranding the drone mid-air.
   */
  _settleOnGround() {
    const t = this.body.translation();
    this.state = DroneState.LANDED;
    // _restY tracks the probed surface, so this seats the drone on a pillar top
    // just as correctly as on the arena floor.
    this.targetY = this._restY;
    this.altitude = 0;
    this.pitch = 0;
    this.roll = 0;
    this.clearInputs();
    this.body.setTranslation({ x: t.x, y: this._restY, z: t.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    // Teleporting would otherwise smear across the interpolation window.
    this.tracked?.resync();
  }

  /**
   * Soft wall: a spring-damper pushing back inside instead of clamping position.
   * Centred on the spawn rather than the world origin — the environment decides
   * where the drone starts, and that is rarely the middle of the asset.
   */
  _containWithinArena(t, v) {
    const limit = WORLD.arenaRadius;
    const dx = t.x - this.spawnPoint.x;
    const dz = t.z - this.spawnPoint.z;
    const distance = Math.hypot(dx, dz);
    if (distance < limit) return;

    const nx = dx / distance;
    const nz = dz / distance;
    const outwardSpeed = v.x * nx + v.z * nz;
    const magnitude =
      -this.spec.mass * ((distance - limit) * 14 + Math.max(0, outwardSpeed) * 6);
    this.body.addForce({ x: nx * magnitude, y: 0, z: nz * magnitude }, true);
  }

  // ---------------------------------------------------------------- visuals

  /**
   * Interpolated render sync. @param {number} alpha 0..1 from PhysicsWorld
   * @param {number} dt frame delta, for rotor spin only
   */
  syncVisual(alpha, dt) {
    if (!this.tracked) return;

    this.tracked.sample(alpha, this.position, this._renderQuat);
    this.root.position.copy(this.position);

    this._euler.set(this.pitch, 0, this.roll, 'YXZ');
    this._tiltQuat.setFromEuler(this._euler);

    // yaw (physics) * commanded lean (visual + thrust)
    this.root.quaternion.copy(this._renderQuat).multiply(this._tiltQuat);

    // Roll about the airframe's own centre. The body genuinely translates while
    // it rotates — banked entry, ballistic fall and recovery are all real
    // forces — so the axis is never fixed in space.
    this.flipPivot.quaternion.setFromAxisAngle(ROLL_AXIS, this.flipRoll);

    const q = this._renderQuat;
    this.yaw = Math.atan2(2 * q.w * q.y, 1 - 2 * q.y * q.y);

    // Airborne means turning, always — thrust modulates the rate but never
    // takes it to zero, so the blades can't appear to stall mid-flight. The
    // spin-up and spin-down on the pad are eased rather than switched.
    const spec = this.spec;
    const target = this.state === DroneState.LANDED ? 0 : spec.rotorIdle + this._thrustRatio;
    this._rotorSpeed += (target - this._rotorSpeed) * (1 - Math.exp(-dt / spec.rotorSpinUp));

    if (this.mixer) {
      this.mixer.timeScale = this._rotorSpeed;
      this.mixer.update(dt);
    } else if (this._rotors.length) {
      this._rotorPhase += dt * spec.rotorSpinRate * this._rotorSpeed;
      for (let i = 0; i < this._rotors.length; i += 1) {
        const { node, baseQuat } = this._rotors[i];
        // Adjacent rotors counter-rotate, as on a real quad. Post-multiplying
        // spins about the hub's *local* Y regardless of how it was authored.
        this._spinQuat.setFromAxisAngle(
          SPIN_AXIS,
          i % 2 === 0 ? this._rotorPhase : -this._rotorPhase,
        );
        node.quaternion.copy(baseQuat).multiply(this._spinQuat);
      }
    }
  }

  getStatus() {
    return {
      state: this.state,
      isFlipping: this.isFlipping,
      canManeuver: this.canManeuver,
      altitude: this.altitude,
      speed: this.speed,
      headingDeg: (((-this.yaw * 180) / Math.PI) % 360 + 360) % 360,
      thrust: this._thrustRatio,
    };
  }

  dispose() {
    this._unsubscribe?.();
    this._unsubscribe = null;

    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
      this.mixer = null;
    }

    if (this.tracked) {
      this.physics.untrack(this.tracked);
      this.tracked = null;
    }
    if (this.body) {
      this.physics.world.removeRigidBody(this.body);
      this.body = null;
    }
    if (this._model) {
      disposeObject3D(this._model);
      this._model = null;
    }
    this.scene.remove(this.root);
    this._rotors.length = 0;
  }
}
