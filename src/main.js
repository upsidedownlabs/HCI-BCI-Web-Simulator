/**
 * Bootstrap: renderer -> physics -> assets -> UI -> render loop.
 *
 * The render loop drives physics through a fixed-step accumulator, so the
 * simulation is identical at 30, 60 or 144 FPS; only the interpolation factor
 * handed to the visuals changes.
 */
import { Box3, Clock, Vector3 } from 'three';

import { SceneManager } from './Scene.js';
import { PhysicsWorld, initPhysics } from './Physics.js';
import { AssetLoader } from './Loaders.js';
import { Environment } from './Environment.js';
import { DroneController, DroneState } from './DroneController.js';
import { UIManager } from './UIManager.js';
import { DEFAULT_DRONE, DRONE_PRESETS, WORLD } from './config.js';

/** Asset prefix. Only non-"/" when the app is deployed under a sub-path. */
const BASE_URL = process.env.NEXT_PUBLIC_BASE_PATH || '/';

/** Swap airframes here (or `?drone=<id>`); nothing else needs to change. */
const droneId = new URLSearchParams(location.search).get('drone') ?? DEFAULT_DRONE;
const spec = DRONE_PRESETS[droneId] ?? DRONE_PRESETS[DEFAULT_DRONE];

const app = document.getElementById('app');
const clock = new Clock();

let scene;
let physics;
let assets;
let environment;
let drone;
let ui;
let disposed = false;

// HUD is only worth repainting a few times a second; DOM writes every frame
// cost more than the render itself on low-end phones.
const HUD_INTERVAL = 0.1;
let hudTimer = 0;
let wasFlipping = false;
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;

async function boot() {
  ui = new UIManager({
    onCommand: (command, active) => {
      drone?.setInput(command, active);
      // Taking a control input means the pilot wants the flight view back.
      if (active) scene?.returnHome();
    },
    onAction: handleAction,
    onOrbit: (dx, dy) => scene?.orbit(dx, dy),
    onZoomBy: (factor) => scene?.zoomBy(factor),
    onZoomSet: (t) => scene?.setZoom01(t),
    onToggle: (name, on) => {
      if (name !== 'autoCamera') return;
      scene?.setAutoFollow(on);
      ui.toast(on ? 'Auto camera on' : 'Auto camera off — free look');
    },
  });

  try {
    scene = new SceneManager(app);
    const backend = await scene.init();
    ui.setProgress(0.05);

    await initPhysics();
    physics = new PhysicsWorld({ gravity: WORLD.gravity });
    // Catch-all far below the terrain: the land is a trimesh with a water
    // channel cut through it, so this only ever catches something that has
    // left the tile entirely.
    physics.createGround({ y: WORLD.safetyFloorY });
    ui.setProgress(0.1);

    assets = new AssetLoader(scene.renderer, BASE_URL);

    environment = new Environment();
    await environment.load(assets, (fraction) => ui.setProgress(0.1 + fraction * 0.5));
    scene.setEnvironment(environment.group);
    // Terrain and props emit their colliders from the same pass that places
    // them, so what you see and what you hit cannot drift apart.
    physics.createStaticColliders(environment.colliders);
    scene.setPadPosition(environment.spawn);
    ui.setProgress(0.6);

    drone = new DroneController({
      physics,
      scene: scene.scene,
      spec,
      spawn: environment.spawn,
    });
    await drone.load(assets, (fraction) => ui.setProgress(0.6 + fraction * 0.35));
    // Size the chase cam and landing pad to whatever airframe just loaded.
    scene.frameSubject(drone.span);
    ui.setProgress(1);

    ui.update(drone.getStatus(), { fps: 0, backend });
    ui.syncZoom(scene.getZoom01());
    ui.hideLoader();
    ui.toast(`${spec.name} ready — drag to orbit, scroll to zoom`, 2600);

    clock.start();
    scene.renderer.setAnimationLoop(frame);
  } catch (error) {
    console.error(error);
    ui?.showError(error?.message ?? 'Failed to start the simulator.');
  }
}

function handleAction(action) {
  if (!drone) return;
  // Reflect the new state on the buttons immediately rather than waiting for
  // the next frame — a takeoff tap should grey the pad out on contact.
  queueMicrotask(() => ui?.syncControls(drone.getStatus()));
  // Flips re-frame once the rotation is done (see the isFlipping edge in
  // frame()) — swinging the camera home mid-manoeuvre fights the drone's own
  // motion and reads as a lurch.
  if (action !== 'flipLeft' && action !== 'flipRight') scene?.returnHome();

  switch (action) {
    // Merged control — the drone's state decides which command it is.
    case 'flight':
      if (drone.state === DroneState.LANDED) {
        if (drone.takeoff()) ui.toast(`Taking off to ${spec.hoverHeight.toFixed(1)} m`);
      } else if (drone.land()) {
        ui.toast('Landing');
      }
      break;
    case 'takeoff':
      if (drone.takeoff()) ui.toast(`Taking off to ${spec.hoverHeight.toFixed(1)} m`);
      break;
    case 'land':
      if (drone.land()) ui.toast('Landing');
      break;
    case 'flipLeft':
      if (drone.flip(-1)) ui.toast('Flip left');
      break;
    case 'flipRight':
      if (drone.flip(1)) ui.toast('Flip right');
      break;
  }
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);

  physics.update(dt);
  drone.syncVisual(physics.alpha, dt);
  scene.updateCamera(drone.position, drone.yaw, dt, drone.altitude);
  // Reuses the flight model's own ground probe, so the shadow sits on whatever
  // is actually beneath — rooftop, bus, or street.
  scene.updateDroneShadow(drone.position, drone.groundY, drone.altitude);
  scene.render();

  const status = drone.getStatus();
  // Button lockout tracks the simulation every frame; text readouts don't
  // need to, and DOM writes are measurable on low-end phones.
  ui.syncControls(status);

  // Falling edge of a flip: ease the camera onto wherever the manoeuvre left
  // the drone. Deliberately at the end, so the re-frame doesn't compete with
  // the rotation for the viewer's attention.
  if (wasFlipping && !status.isFlipping) scene.returnHome();
  wasFlipping = status.isFlipping;

  fpsAccum += dt;
  fpsFrames += 1;
  hudTimer += dt;
  if (hudTimer >= HUD_INTERVAL) {
    if (fpsAccum > 0) fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
    hudTimer = 0;
    ui.update(status, { fps });
    // Keep the slider honest after wheel, pinch or an auto-camera return.
    ui.syncZoom(scene.getZoom01());
  }
}

/** Release everything the GPU and WASM heap are holding. */
function dispose() {
  if (disposed) return;
  disposed = true;

  scene?.renderer?.setAnimationLoop(null);
  ui?.dispose();
  drone?.dispose();
  environment?.dispose();
  assets?.dispose();
  physics?.dispose();
  scene?.dispose();

  ui = drone = environment = assets = physics = scene = null;
}

/**
 * Introspection hook. Useful for tuning flight constants from the console
 * (`__sim.drone().spec.maxTiltDeg = 25`) and used by tests/browser-smoke.mjs.
 */
window.__sim = {
  drone: () => drone,
  scene: () => scene,
  environment: () => environment,
  physics: () => physics,
  /** Simulated seconds — use instead of wall-clock when scripting the sim. */
  simTime: () => physics.elapsed,
  camera: () => ({
    azimuthDeg: (scene.azimuth * 180) / Math.PI,
    elevationDeg: (scene.elevation * 180) / Math.PI,
    distance: scene.distance,
    zoom01: scene.getZoom01(),
    autoFollow: scene.autoFollow,
    minDistance: scene.minDistance,
    maxDistance: scene.maxDistance,
  }),
  pose: () => ({
    state: drone.state,
    isFlipping: drone.isFlipping,
    x: drone.position.x,
    y: drone.position.y,
    z: drone.position.z,
    altitude: drone.altitude,
    speed: drone.speed,
    pitchDeg: (drone.pitch * 180) / Math.PI,
    rollDeg: (drone.roll * 180) / Math.PI,
    yawDeg: (drone.yaw * 180) / Math.PI,
    flipRollDeg: (drone.flipRoll * 180) / Math.PI,
    /** Angular velocity about the roll axis, rad/s — integrated from torque. */
    flipRate: drone.flipRate ?? 0,
    flipPhase: drone._flipPhase ?? null,
  }),
  modelInfo: () => {
    let triangles = 0;
    let meshes = 0;
    drone.root.traverse((o) => {
      if (!o.isMesh) return;
      meshes += 1;
      const g = o.geometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    const size = new Box3().setFromObject(drone.pivot).getSize(new Vector3());
    return {
      size: [+size.x.toFixed(4), +size.y.toFixed(4), +size.z.toFixed(4)],
      triangles: Math.round(triangles),
      meshes,
      hasMixer: Boolean(drone.mixer),
      rotorCount: drone._rotors.length,
      rotorNames: drone._rotors.map((r) => r.node.name),
      colliderHalfExtents: drone._halfExtents.toArray().map((v) => +v.toFixed(4)),
    };
  },
};

// `pagehide` fires on iOS Safari where `beforeunload` does not.
window.addEventListener('pagehide', dispose);
window.addEventListener('beforeunload', dispose);

export { dispose };

boot();
