/**
 * Renderer, camera rig, lighting and the landing pad.
 *
 * The world itself is loaded and assembled by Environment.js and handed here
 * via setEnvironment() — this module owns presentation, not content.
 *
 * Renderer selection: a single WebGPURenderer is used for both paths. When
 * `navigator.gpu` is missing (or WebGPU init throws) it is recreated with
 * `forceWebGL: true`, which drives the same node-material pipeline over WebGL2.
 * One code path, one bundle — importing the legacy WebGLRenderer as a fallback
 * would ship a second copy of Three.
 */
import * as THREE from 'three';
import { CAMERA, RENDER, WORLD } from './config.js';

const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Shortest signed angular difference, so orbit returns never take the long way. */
function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Recursively dispose geometry, materials and any textures they reference. */
export function disposeObject3D(root) {
  const materials = new Set();
  root.traverse((obj) => {
    obj.geometry?.dispose();
    if (obj.material) {
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        materials.add(m);
      }
    }
  });
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value && value.isTexture) value.dispose();
    }
    material.dispose();
  }
  root.parent?.remove(root);
}

export class SceneManager {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.renderer = null;
    this.backend = 'unknown';
    this.dofEnabled = false;
    this.isMobile = IS_MOBILE;

    this.scene = new THREE.Scene();
    // Far plane covers the whole village (500 m across) plus headroom.
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.05, 1200);

    /** Set by setEnvironment(); geometry and colliders come from Environment.js. */
    this.environment = null;

    // --- orbit camera -------------------------------------------------------
    // The camera always sits on a sphere centred on the drone, so the subject
    // stays dead centre and only the viewpoint moves. `azimuth` is a *world*
    // angle: while auto-follow is settled it tracks the drone's heading (a
    // chase cam), and once the user drags it holds still in world space so
    // yawing the drone doesn't drag the view around with it.
    this.azimuth = 0;
    this.elevation = CAMERA.defaultElevation;
    this.distance = 0.9;
    this.minDistance = 0.4;
    this.maxDistance = 2.5;
    this.autoFollow = true;
    /**
     * Wall-clock stamp of the last camera input. Deliberately not accumulated
     * from render `dt`: that value is clamped to protect the physics loop, so
     * on a slow device a "3 second" idle timer would never actually elapse.
     */
    this._lastUserInputAt = -Infinity;
    this._followLift = 0.06;
    this._subjectSpan = 0.18;

    this._cameraTarget = new THREE.Vector3(0, 0.8, 0);
    this._lookAt = new THREE.Vector3(0, 0.8, 0);
    this._desired = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._onResize = () => this.resize();
  }

  // ------------------------------------------------------------ orbit camera

  /**
   * Drag delta in pixels. Dragging right swings the view left around the
   * drone; dragging down lifts the camera over the top.
   */
  orbit(dx, dy) {
    this.azimuth -= dx * CAMERA.orbitSensitivity;
    this.elevation = clamp(
      this.elevation + dy * CAMERA.orbitSensitivity,
      CAMERA.minElevation,
      CAMERA.maxElevation,
    );
    this._lastUserInputAt = performance.now();
  }

  /** @param {number} factor multiplicative zoom; >1 pulls back. */
  zoomBy(factor) {
    this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
    this._lastUserInputAt = performance.now();
  }

  /**
   * @param {number} t 0 = closest, 1 = furthest.
   *
   * Exponential, not linear: the range spans roughly 0.4 m to 35 m, so a linear
   * slider would compress every useful close-in distance into its first 2%.
   */
  setZoom01(t) {
    const span = this.maxDistance / this.minDistance;
    this.distance = this.minDistance * span ** clamp(t, 0, 1);
    this._lastUserInputAt = performance.now();
  }

  getZoom01() {
    const span = this.maxDistance / this.minDistance;
    return span > 1 ? Math.log(this.distance / this.minDistance) / Math.log(span) : 0;
  }

  setAutoFollow(enabled) {
    this.autoFollow = Boolean(enabled);
    // Turning it on shouldn't yank the view — let the normal delay run first.
    if (this.autoFollow) this._lastUserInputAt = performance.now();
  }

  /**
   * Begin easing back behind the drone now instead of after the idle delay.
   * Called when the pilot takes a control input: they want the flight view
   * back, but *arriving* there is still a smooth glide at the normal return
   * rate — a hard cut is disorienting mid-flight.
   *
   * No-op while auto-follow is off; that mode exists to hold a chosen angle.
   */
  returnHome() {
    if (!this.autoFollow) return;
    this._lastUserInputAt = -Infinity;
  }

  async init() {
    await this._createRenderer();
    this._buildLighting();
    this._buildPad();
    this._buildDroneShadow();
    await this._setupPostProcessing();

    this.camera.position.set(0, 1.9, 3.4);
    this.camera.lookAt(this._lookAt);

    this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });

    return this.backend;
  }

  async _createRenderer() {
    const build = async (forceWebGL) => {
      // A canvas that failed WebGPU context creation can't be reused for the
      // fallback, so each attempt gets a fresh one.
      const canvas = document.createElement('canvas');
      canvas.id = 'viewport';
      const renderer = new THREE.WebGPURenderer({
        canvas,
        antialias: !IS_MOBILE,
        alpha: false,
        powerPreference: 'high-performance',
        forceWebGL,
      });
      await renderer.init();
      return { renderer, canvas };
    };

    let result;
    if (navigator.gpu) {
      try {
        result = await build(false);
      } catch (err) {
        console.warn('[Scene] WebGPU unavailable, falling back to WebGL2:', err);
      }
    }
    result ??= await build(true);

    this.renderer = result.renderer;
    this.container.prepend(result.canvas);
    this.backend = this.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';

    // Pixel ratio is the single biggest mobile perf lever — 3x DPR phones are
    // rendering ~9x the fragments for no perceptible gain.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_MOBILE ? 1.5 : 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = IS_MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  }

  _buildLighting() {
    // Daylight, to suit the stylised outdoor kit — the previous palette was a
    // dark arena and left the flat-shaded foliage muddy.
    this.scene.background = new THREE.Color(0x8fc4e8);
    // Sized to the village, not the old 24 m island: nothing within the flight
    // area is fogged, it only softens the far edge of the map.
    this.scene.fog = new THREE.Fog(0x8fc4e8, 160, 700);

    // Hemisphere fill gives cheap sky/ground colour separation — a lot of
    // perceived depth for one light and zero shadow cost.
    this.scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x5b6b45, 2.0));

    const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
    key.position.set(38, 60, 26);
    key.castShadow = true;
    const size = this.isMobile ? 512 : 1024;
    key.shadow.mapSize.set(size, size);
    key.shadow.bias = -0.0015;
    key.shadow.normalBias = 0.02;
    // The frustum follows the drone (see updateCamera), so it only has to span
    // the drone's surroundings — wide enough that nearby buildings cast, tight
    // enough that 1024² still resolves the drone's own shadow.
    const cam = key.shadow.camera;
    cam.left = -45;
    cam.right = 45;
    cam.top = 45;
    cam.bottom = -45;
    cam.near = 1;
    cam.far = 190;
    cam.updateProjectionMatrix();
    this.scene.add(key);
    this.keyLight = key;

    const rim = new THREE.DirectionalLight(0x9ec8ff, 0.8);
    rim.position.set(-7, 4, -6);
    this.scene.add(rim);
  }

  /**
   * Host the loaded environment. The scene no longer generates its own props —
   * geometry and colliders both come from Environment.js, produced by the same
   * pass so they cannot disagree.
   *
   * @param {THREE.Object3D} group
   */
  setEnvironment(group) {
    if (this.environment) disposeObject3D(this.environment);
    this.environment = group;
    this.scene.add(group);
  }

  /** Landing-pad ring, sized to the drone and moved to its spawn point. */
  /**
   * Contact shadow cast straight down from the drone.
   *
   * The directional shadow map cannot do this job: its frustum spans 90 m so an
   * 18 cm drone resolves to about two texels at 1024². Yet the shadow is the
   * single strongest cue for *how high* the drone is — without it a drone at
   * 40 m and one at 1 m look identical. So this is drawn explicitly, sized and
   * faded by the altitude the ground probe already reports, which costs one
   * textured quad and works on any device.
   */
  _buildDroneShadow() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(0,0,0,1)');
    gradient.addColorStop(0.45, 'rgba(0,0,0,0.82)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      // Fog would tint the shadow toward the sky colour when the drone is far
      // from the camera, which is exactly when it needs to stay readable.
      fog: false,
    });

    const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    blob.rotation.x = -Math.PI / 2;
    blob.renderOrder = 2;
    blob.frustumCulled = false;
    this._shadowBlob = blob;
    this._shadowMaterial = material;
    this._shadowTexture = texture;
    this.scene.add(blob);
  }

  /**
   * @param {THREE.Vector3} position drone position
   * @param {number} groundY surface height beneath it, from the physics probe
   * @param {number} altitude height above that surface
   */
  updateDroneShadow(position, groundY, altitude) {
    const blob = this._shadowBlob;
    if (!blob) return;

    const cfg = RENDER.contactShadow;
    const span = this._subjectSpan;
    // Spreads and fades with height, the way a real shadow's penumbra does.
    const radius = span * (cfg.baseRadius + altitude * cfg.growth);
    blob.scale.set(radius, radius, 1);
    blob.position.set(position.x, groundY + cfg.lift, position.z);
    this._shadowMaterial.opacity = cfg.opacity / (1 + altitude * cfg.fade);
  }

  _buildPad() {
    const material = new THREE.MeshStandardMaterial({
      color: 0x2f81f7,
      emissive: 0x1c4d8f,
      emissiveIntensity: 0.8,
      roughness: 0.4,
      transparent: true,
      opacity: 0.85,
    });
    // Unit-radius ring so frameSubject() can scale it to whatever drone loads.
    const pad = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.0, 40), material);
    pad.rotation.x = -Math.PI / 2;
    pad.scale.setScalar(0.2);
    pad.renderOrder = 1;
    this._padMaterial = material;
    this._pad = pad;
    this.scene.add(pad);
  }

  /** @param {THREE.Vector3} position world spawn point the pad marks */
  setPadPosition(position) {
    if (!this._pad) return;
    // Enough clearance that the ring isn't half-swallowed where the ground
    // slopes across it — 3 cm is invisible next to an 18 cm drone.
    this._pad.position.set(position.x, position.y + 0.03, position.z);
  }

  /**
   * Size the camera rig to the subject. Called once the model is loaded, so
   * zoom limits and framing hold for any airframe.
   * @param {number} span largest horizontal dimension of the drone, metres
   */
  frameSubject(span) {
    this.distance = span * CAMERA.distanceSpans;
    this.minDistance = span * CAMERA.minDistanceSpans;
    // Closest is drone-relative (for inspecting an 18 cm airframe), furthest is
    // world-relative: in a 500 m village you need to pull back far enough to see
    // what you are flying over, which a span-derived limit never reaches.
    this.maxDistance = CAMERA.maxDistanceMetres;
    this._homeDistanceValue = span * CAMERA.distanceSpans;
    this._followLift = span * 0.35;
    this.camera.near = Math.min(0.05, span * 0.2);
    this.camera.updateProjectionMatrix();
    this._subjectSpan = span;
    this._pad?.scale.setScalar(span * 1.15);
  }

  /**
   * Orbit camera. Exponential smoothing (rather than a fixed lerp factor) keeps
   * every rate frame-rate independent.
   *
   * @param {THREE.Vector3} position drone position
   * @param {number} yaw drone heading, radians
   * @param {number} dt frame delta
   */
  updateCamera(position, yaw, dt, altitude = 0) {
    // Auto-adjust: after the idle delay (or immediately, once returnHome() has
    // been called), ease the viewpoint back behind the drone. Until then — or
    // forever, if auto-follow is off — it stays where the user left it.
    // Everything here is an exponential ease, never a cut.
    const idleSeconds = (performance.now() - this._lastUserInputAt) / 1000;
    if (this.autoFollow && idleSeconds >= CAMERA.autoReturnDelay) {
      const k = 1 - Math.exp(-CAMERA.returnSmoothing * dt);

      // Azimuth gets its own rate, blended by how far behind it currently is.
      // Keeping station behind a turning drone and unwinding a half-turn of
      // user drag are the same operation with opposite requirements: the first
      // has to be tight or the world visibly slews late, the second has to be
      // loose or it lurches. Interpolating on the error serves both, and is
      // continuous, so there is no rate step as the camera catches up.
      const offset = angleDelta(this.azimuth, yaw);
      const far = clamp(Math.abs(offset) / CAMERA.yawCatchUpAngle, 0, 1);
      const yawRate =
        CAMERA.yawFollowSmoothing + (CAMERA.returnSmoothing - CAMERA.yawFollowSmoothing) * far;
      this.azimuth += offset * (1 - Math.exp(-yawRate * dt));
      // Look further down the higher the drone gets. With the camera barely a
      // metre from an 18 cm airframe, a level chase view at 35 m shows nothing
      // but sky — tilting over the top is what puts the ground back in frame
      // and makes the altitude legible.
      const climb = clamp(altitude / CAMERA.lookDownAltitude, 0, 1);
      const home =
        CAMERA.defaultElevation +
        (CAMERA.maxElevation - CAMERA.defaultElevation) * climb * CAMERA.lookDownAmount;
      this.elevation += (home - this.elevation) * k;
      this.distance += (this._homeDistance() - this.distance) * k;
    }

    const cosEl = Math.cos(this.elevation);
    this._offset.set(
      Math.sin(this.azimuth) * cosEl,
      Math.sin(this.elevation),
      Math.cos(this.azimuth) * cosEl,
    );
    this._desired.copy(position).addScaledVector(this._offset, this.distance);
    // Never let the camera sink through the floor.
    this._desired.y = Math.max(this._desired.y, WORLD.groundY + this._followLift * 0.8);

    this.camera.position.lerp(this._desired, 1 - Math.exp(-CAMERA.followSmoothing * dt));
    this._cameraTarget.copy(position).y += this._followLift;
    this._lookAt.lerp(this._cameraTarget, 1 - Math.exp(-12 * dt));
    this.camera.lookAt(this._lookAt);

    // Keep the shadow frustum centred on the action instead of the origin.
    this.keyLight.position.set(position.x + 38, position.y + 60, position.z + 26);
    this.keyLight.target.position.copy(position);
    this.keyLight.target.updateMatrixWorld();
  }

  _homeDistance() {
    return clamp(this._homeDistanceValue ?? this.distance, this.minDistance, this.maxDistance);
  }

  /**
   * Depth of field, focused on the drone.
   *
   * This is the second half of selling altitude. Holding focus on the drone
   * while the ground falls out of it is the tilt-shift cue the eye reads as
   * "small subject, seen from high up" — with everything uniformly sharp, a
   * drone at 40 m just looks like a drone on a textured floor.
   *
   * It is a full-screen multi-pass effect, so it is off on mobile by default;
   * `RENDER.depthOfField.enabled` overrides. Any failure falls back to direct
   * rendering rather than taking the app down.
   */
  async _setupPostProcessing() {
    const cfg = RENDER.depthOfField;
    // `?dof=0` / `?dof=1` overrides the config, so it can be switched without a
    // rebuild — the automated tests use it, since a full-screen multi-pass blur
    // is far too slow under a software rasteriser.
    const override = new URLSearchParams(location.search).get('dof');
    const wanted =
      override !== null
        ? override !== '0' && override !== 'false'
        : cfg.enabled === 'desktop'
          ? !this.isMobile
          : Boolean(cfg.enabled);
    if (!wanted) return;

    try {
      const [{ pass, uniform }, { dof }] = await Promise.all([
        import('three/tsl'),
        import('three/addons/tsl/display/DepthOfFieldNode.js'),
      ]);

      this._focusDistance = uniform(cfg.focusDistance);

      const scenePass = pass(this.scene, this.camera);
      this._postProcessing = new THREE.PostProcessing(this.renderer);
      this._postProcessing.outputNode = dof(
        scenePass.getTextureNode('output'),
        scenePass.getViewZNode(),
        this._focusDistance,
        cfg.focalLength,
        cfg.bokehScale,
      );
      this.dofEnabled = true;
    } catch (err) {
      console.warn('[Scene] depth of field unavailable, rendering directly:', err);
      this._postProcessing = null;
      this.dofEnabled = false;
    }
  }

  /**
   * Keep the drone sharp regardless of zoom: the focal plane sits at the
   * camera's actual distance to it, so pulling back doesn't blur the subject.
   */
  _updateFocus() {
    if (!this._focusDistance) return;
    // Only the focal plane tracks the subject; the sharp depth around it is a
    // fixed number of metres, so zooming doesn't change how much of the world
    // is in focus.
    this._focusDistance.value = this.camera.position.distanceTo(this._lookAt);
  }

  render() {
    if (this._postProcessing) {
      this._updateFocus();
      this._postProcessing.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);

    // The environment owns its own geometry and shared material; it is disposed
    // by main.js so the loader-side texture sharing is released with it.
    this.environment = null;
    this._pad?.geometry.dispose();
    this._padMaterial?.dispose();
    this._shadowBlob?.geometry.dispose();
    this._shadowTexture?.dispose();
    this._shadowMaterial?.dispose();
    this._postProcessing?.dispose?.();
    this._postProcessing = null;

    this.scene.clear();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.renderer = null;
  }
}
