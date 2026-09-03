/**
 * Loads the village scene and derives its collision from the geometry.
 *
 * Unlike a prop kit, this asset is one pre-built scene, so there is no layout to
 * generate — the work is making it *flyable*:
 *
 *  - **Collision.** Every mesh is merged into a single Rapier trimesh in world
 *    space. Exact, so the drone can set down on a rooftop, a dumpster or a
 *    wrecked bus, and can thread doorways instead of hitting an approximated
 *    box. One collider on one fixed body is also far cheaper for Rapier than
 *    hundreds of separate ones.
 *  - **Ground reference.** The scene's ground sits at y ~= -25, which every
 *    altitude constant in the sim would otherwise have to know about. The whole
 *    group is shifted so the spawn ground is exactly y = 0.
 *  - **Spawn.** Found by probing, not hard-coded: a coarse grid of downward
 *    rays, filtered to flat faces with real headroom above them, so the drone
 *    never starts inside a building or on a roof slope.
 *
 * Credit: "chicken gun fruzer village" by amogusstrikesback2, CC-BY-4.0.
 * See public/chicken_gun_fruzer_village/license.txt.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { ENVIRONMENT } from './config.js';
import { disposeObject3D } from './Scene.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

export class Environment {
  constructor(config = ENVIRONMENT) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = 'environment';
    /** Static collider descriptors for PhysicsWorld.createStaticColliders(). */
    this.colliders = [];
    /** World-space point the drone starts from, on flat open ground. */
    this.spawn = new THREE.Vector3();
    this.stats = { triangles: 0, drawCalls: 0, materials: 0, textures: 0, extent: 0 };
    this._model = null;
  }

  /**
   * @param {import('./Loaders.js').AssetLoader} loader
   * @param {(fraction:number)=>void} [onProgress]
   */
  async load(loader, onProgress) {
    const cfg = this.config;
    const gltf = await loader.loadGLTF(cfg.path, (f) => onProgress?.(f * 0.85));

    this._model = gltf.scene;
    this._model.scale.setScalar(cfg.scale);
    this.group.add(this._model);
    this.group.updateMatrixWorld(true);

    this._prepareMaterials();
    this._findSpawn();
    onProgress?.(0.85);
    // Collision reads the original per-mesh geometry directly, so it has to
    // run before the batching step below removes those meshes.
    this._buildCollision();
    onProgress?.(0.92);
    this._buildRenderBatches();
    onProgress?.(1);

    return this;
  }

  /** Shadow flags, colour space, and a count of what actually loaded. */
  _prepareMaterials() {
    const materials = new Set();
    const textures = new Set();
    let triangles = 0;
    let drawCalls = 0;

    this._model.traverse((obj) => {
      if (!obj.isMesh) return;
      drawCalls += 1;
      const g = obj.geometry;
      triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;

      obj.castShadow = true;
      obj.receiveShadow = true;
      // The scene is far larger than the flight area; per-object culling is
      // worth keeping on here, unlike the instanced kit it replaced.
      obj.frustumCulled = true;

      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        if (!m || materials.has(m)) continue;
        materials.add(m);
        if (m.map) {
          m.map.colorSpace = THREE.SRGBColorSpace;
          m.map.anisotropy = 4;
          textures.add(m.map);
        }
        // Sketchfab exports often carry a metallic factor that reads as grey
        // plastic under a bright key light; this is flat painted artwork.
        if (m.metalness !== undefined && !m.metalnessMap) m.metalness = 0;
      }
    });

    const box = new THREE.Box3().setFromObject(this._model);
    const size = box.getSize(new THREE.Vector3());

    this.stats.triangles = Math.round(triangles);
    this.stats.drawCalls = drawCalls;
    this.stats.materials = materials.size;
    this.stats.textures = textures.size;
    this.stats.extent = Math.round(Math.max(size.x, size.z));
  }

  /**
   * Collapse the scene's ~190 individual meshes into a handful of draw calls
   * per material, chunked on a coarse world-space grid.
   *
   * At this mesh count, per-mesh draw call submission — not triangle count —
   * is the dominant render cost, and every mesh also draws a second time for
   * its shadow depth pass. Merging by material alone would fix that but lose
   * frustum culling for the whole village at once; chunking keeps culling
   * working at the grid-cell level, so distant parts of the village (it is
   * far larger than the flight arena) still cost nothing.
   *
   * Runs after `_buildCollision()`, which is what still needs the original
   * per-mesh geometry; every original mesh is removed once this is done, not
   * merely hidden — an invisible mesh still costs a full matrix-world update
   * and a frustum test every frame, so leaving ~190 dead ones in the graph
   * would have quietly undone the saving.
   */
  _buildRenderBatches() {
    const cellSize = this.config.renderBatchChunkSize;
    const groupInverse = this.group.matrixWorld.clone().invert();
    const localMatrix = new THREE.Matrix4();
    const centre = new THREE.Vector3();

    /** key -> { material, geometries: THREE.BufferGeometry[] } */
    const batches = new Map();
    const originals = [];

    this._model.traverse((obj) => {
      if (!obj.isMesh) return;
      const geometry = obj.geometry;
      if (!geometry.getAttribute('position')) return;
      // GLTFLoader emits one primitive per material, so a multi-material mesh
      // is effectively absent here; render the rare one unmerged rather than
      // risk grouping its triangles under the wrong material.
      if (Array.isArray(obj.material) || !obj.material) return;
      const material = obj.material;

      localMatrix.multiplyMatrices(groupInverse, obj.matrixWorld);

      if (!geometry.boundingBox) geometry.computeBoundingBox();
      geometry.boundingBox.getCenter(centre).applyMatrix4(localMatrix);
      const cellX = Math.floor(centre.x / cellSize);
      const cellZ = Math.floor(centre.z / cellSize);
      const key = `${material.uuid}|${cellX}|${cellZ}`;

      let batch = batches.get(key);
      if (!batch) {
        batch = { material, geometries: [] };
        batches.set(key, batch);
      }
      batch.geometries.push(geometry.clone().applyMatrix4(localMatrix));
      originals.push(obj);
    });

    // Removed only after the traversal completes — mutating a parent's
    // children mid-`traverse()` skips siblings.
    for (const obj of originals) obj.parent?.remove(obj);

    for (const { material, geometries } of batches.values()) {
      const merged = geometries.length > 1 ? mergeGeometries(geometries, false) : geometries[0];
      // Attribute mismatch across the group (rare) — render unmerged rather
      // than silently drop geometry.
      const built = merged ? [merged] : geometries;

      for (const geometry of built) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
  }

  /**
   * Probe a grid of downward rays and pick open, level ground near the middle
   * of the scene. Hard-coding a spawn would silently break the moment the asset
   * is swapped, and starting inside a warehouse is an easy mistake to make in a
   * scene with 187 meshes.
   */
  _findSpawn() {
    const cfg = this.config;
    const box = new THREE.Box3().setFromObject(this._model);
    const centre = box.getCenter(new THREE.Vector3());
    const raycaster = new THREE.Raycaster();
    const from = new THREE.Vector3();
    const worldNormal = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();

    const half = cfg.spawnSearchRadius;
    const step = (half * 2) / cfg.spawnSearchSteps;
    let best = null;

    for (let x = centre.x - half; x <= centre.x + half; x += step) {
      for (let z = centre.z - half; z <= centre.z + half; z += step) {
        raycaster.set(from.set(x, box.max.y + 50, z), DOWN);
        const hit = raycaster.intersectObject(this._model, true)[0];
        if (!hit) continue;

        // Level ground only — no roof pitches or rubble piles. `face.normal`
        // is in the hit mesh's own local space; a node with non-uniform scale
        // anywhere in the village would otherwise compare a distorted normal
        // against the threshold instead of the real world-space slope.
        if (!hit.face) continue;
        normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        worldNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
        if (worldNormal.y < cfg.maxSlopeNormalY) continue;

        // Headroom: anything directly overhead means we are indoors or under a
        // canopy, which is a poor place to start a drone.
        raycaster.set(from.copy(hit.point).addScaledVector(UP, 0.25), UP);
        const above = raycaster.intersectObject(this._model, true)[0];
        if (above && above.distance < cfg.spawnHeadroom) continue;

        // Prefer low, central ground: the village floor rather than a rooftop.
        const score = hit.point.y + hit.point.distanceTo(centre) * 0.02;
        if (!best || score < best.score) best = { point: hit.point.clone(), score };
      }
    }

    if (!best) throw new Error('Environment: no open ground found for the spawn');

    // Drop the whole scene so that spot is exactly y = 0. Everything else in
    // the sim measures altitude from there.
    this.group.position.y = -best.point.y;
    this.group.updateMatrixWorld(true);
    this.spawn.set(best.point.x, 0, best.point.z);
  }

  /**
   * Merge every mesh into one world-space trimesh. Static geometry only, which
   * is what trimesh is for — it has no interior, so a dynamic body that ends up
   * inside one is not pushed back out.
   */
  _buildCollision() {
    const positions = [];
    const indices = [];
    let offset = 0;
    const vertex = new THREE.Vector3();

    this._model.updateWorldMatrix(true, true);
    this._model.traverse((obj) => {
      if (!obj.isMesh) return;
      const geometry = obj.geometry;
      const attr = geometry.getAttribute('position');
      if (!attr) return;

      for (let i = 0; i < attr.count; i += 1) {
        vertex.fromBufferAttribute(attr, i).applyMatrix4(obj.matrixWorld);
        positions.push(vertex.x, vertex.y, vertex.z);
      }

      const index = geometry.getIndex();
      if (index) {
        for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
      } else {
        for (let i = 0; i < attr.count; i += 1) indices.push(i + offset);
      }
      offset += attr.count;
    });

    this.colliders.push({
      shape: 'trimesh',
      vertices: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
      friction: 0.7,
      restitution: 0.1,
    });
    this.stats.collisionTriangles = indices.length / 3;
  }

  dispose() {
    disposeObject3D(this.group);
    this._model = null;
    this.colliders.length = 0;
  }
}
