/**
 * Asset pipeline: GLTF + Draco + KTX2/Basis + Meshopt.
 *
 * Transcoder binaries resolve through the bundler — no CDN, and no explicit
 * decoder paths. They are only fetched if a model actually declares the
 * corresponding glTF extension, so wiring all three costs nothing for
 * uncompressed assets like the stock Tello.
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export class AssetLoader {
  /**
   * @param {import('three').Renderer} renderer used to detect which compressed
   *        texture formats the GPU supports (ASTC/ETC2/BC/…).
   * @param {string} baseUrl app base that asset paths resolve against.
   */
  constructor(renderer, baseUrl = '/') {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

    this.draco = new DRACOLoader();
    this.ktx2 = new KTX2Loader();

    // Picks the best compressed format the GPU exposes (ASTC / ETC2 / BC / …)
    // so KTX2 textures are transcoded once, on device, to something native.
    try {
      this.ktx2.detectSupport(renderer);
    } catch (err) {
      // Older KTX2Loader builds only understand WebGLRenderer. Uncompressed
      // textures still load fine, so this is a soft failure.
      console.warn('[AssetLoader] KTX2 support detection failed:', err);
    }

    this.gltf = new GLTFLoader()
      .setDRACOLoader(this.draco)
      .setKTX2Loader(this.ktx2)
      .setMeshoptDecoder(MeshoptDecoder);

    this.baseUrl = base;
  }

  /**
   * @param {string} path relative to the app base
   * @param {(fraction:number)=>void} [onProgress] 0..1, only fires when the
   *        server sends Content-Length
   * @returns {Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>}
   */
  loadGLTF(path, onProgress) {
    const url = /^(https?:)?\/\//.test(path) ? path : `${this.baseUrl}${path}`;
    return new Promise((resolve, reject) => {
      this.gltf.load(
        url,
        resolve,
        (evt) => {
          // Clamped: `total` comes from Content-Length, which on a compressing
          // CDN (GitHub Pages included) is the size on the wire, while `loaded`
          // counts decompressed bytes as the browser inflates the stream — for
          // a compressible asset that ratio can genuinely run past 1.
          if (onProgress && evt.lengthComputable) onProgress(Math.min(1, evt.loaded / evt.total));
        },
        (err) => reject(new Error(`Failed to load "${url}": ${err?.message ?? err}`)),
      );
    });
  }

  dispose() {
    this.draco.dispose();
    this.ktx2.dispose();
  }
}
