/**
 * Rapier wrapper with a fixed 60 Hz timestep decoupled from rendering.
 *
 * The render loop calls `update(frameDelta)`; this class runs however many
 * whole 60 Hz steps fit into the accumulated time and exposes `alpha`, the
 * 0..1 remainder used to interpolate visuals between the last two physics
 * states. That keeps simulation behaviour identical on a 60 Hz phone and a
 * 144 Hz desktop, and removes judder when the two rates don't divide evenly.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';

export { RAPIER };

export const FIXED_DT = 1 / 60;

/** Cap on catch-up steps per frame — prevents a spiral of death after a stall. */
const MAX_SUBSTEPS = 5;
/** Frame deltas longer than this (tab was backgrounded) are discarded. */
const MAX_FRAME_DELTA = 0.25;

let wasmReady = null;

/** Idempotent; safe to await from multiple call sites. */
export function initPhysics() {
  wasmReady ??= RAPIER.init().then(() => RAPIER);
  return wasmReady;
}

/**
 * Snapshots a body's transform each step so visuals can be interpolated
 * instead of snapping to the latest physics tick.
 */
class TrackedBody {
  constructor(body) {
    this.body = body;
    this.prevPosition = new Vector3();
    this.prevQuaternion = new Quaternion();
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.read();
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }

  /** Latest becomes previous, ahead of a new step. */
  capture() {
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }

  /** Pull the post-step transform out of Rapier. */
  read() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
  }

  /** @param {number} alpha 0..1 */
  sample(alpha, outPosition, outQuaternion) {
    outPosition.copy(this.prevPosition).lerp(this.position, alpha);
    outQuaternion.copy(this.prevQuaternion).slerp(this.quaternion, alpha);
  }

  /** Called after teleporting a body so interpolation doesn't smear. */
  resync() {
    this.read();
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }
}

export class PhysicsWorld {
  constructor({ gravity = 9.81 } = {}) {
    this.world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
    this.world.timestep = FIXED_DT;

    this.accumulator = 0;
    /** Interpolation factor for the current frame, 0..1. */
    this.alpha = 0;
    /** Fixed steps executed on the most recent `update()`. */
    this.stepsLastFrame = 0;
    /**
     * Total simulated seconds. Diverges from wall-clock when the renderer
     * can't keep up and the substep cap kicks in — which is the point: the
     * sim degrades to slow-motion rather than exploding.
     */
    this.elapsed = 0;

    /** @type {Set<(dt:number)=>void>} */
    this.steppers = new Set();
    /** @type {TrackedBody[]} */
    this.tracked = [];
  }

  /**
   * Register a callback invoked immediately before each `world.step()`.
   * @returns {() => void} unsubscribe
   */
  onFixedStep(fn) {
    this.steppers.add(fn);
    return () => this.steppers.delete(fn);
  }

  /** @returns {TrackedBody} */
  track(body) {
    const tracked = new TrackedBody(body);
    this.tracked.push(tracked);
    return tracked;
  }

  untrack(tracked) {
    const i = this.tracked.indexOf(tracked);
    if (i !== -1) this.tracked.splice(i, 1);
  }

  createGround({ y = 0, halfExtent = 60, thickness = 0.5 } = {}) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, y - thickness, 0),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtent, thickness, halfExtent)
        .setFriction(1.0)
        .setRestitution(0),
      body,
    );
    return body;
  }

  /**
   * Attach static world geometry. All descriptors share a single fixed body —
   * Rapier handles many colliders on one body far more cheaply than many
   * bodies, and none of these ever move.
   *
   * @param {Array<{shape:'box'|'cylinder', position:number[], rotationY?:number,
   *                halfExtents?:number[], radius?:number, halfHeight?:number}>} descriptors
   */
  createStaticColliders(descriptors) {
    if (!descriptors?.length) return null;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    for (const d of descriptors) {
      let desc;
      if (d.shape === 'cylinder') {
        desc = RAPIER.ColliderDesc.cylinder(d.halfHeight, d.radius);
      } else if (d.shape === 'trimesh') {
        // Exact terrain. Static only — trimesh has no interior, so a dynamic
        // body that tunnels inside one will not be pushed back out.
        desc = RAPIER.ColliderDesc.trimesh(d.vertices, d.indices);
      } else {
        desc = RAPIER.ColliderDesc.cuboid(...d.halfExtents);
      }

      desc
        .setTranslation(...(d.position ?? [0, 0, 0]))
        .setFriction(d.friction ?? 0.5)
        .setRestitution(d.restitution ?? 0.3);
      if (d.rotationY) {
        const half = d.rotationY / 2;
        desc.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
      }
      this.world.createCollider(desc, body);
    }
    return body;
  }

  /** @param {number} frameDelta seconds since the previous rendered frame */
  update(frameDelta) {
    this.accumulator += Math.min(frameDelta, MAX_FRAME_DELTA);

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const t of this.tracked) t.capture();
      for (const step of this.steppers) step(FIXED_DT);
      this.world.step();
      for (const t of this.tracked) t.read();

      this.accumulator -= FIXED_DT;
      this.elapsed += FIXED_DT;
      steps += 1;
    }

    // Ran out of budget: drop the backlog rather than compounding it.
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    this.stepsLastFrame = steps;
    this.alpha = this.accumulator / FIXED_DT;
  }

  dispose() {
    this.steppers.clear();
    this.tracked.length = 0;
    this.world.free();
    this.world = null;
  }
}
