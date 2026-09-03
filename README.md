# Tello Drone Simulator

A 3D drone flight simulator that runs in the browser, with flying and flip controls over a small village scene.

Built with [Next.js](https://nextjs.org/), [Three.js](https://threejs.org/) (WebGPU with a WebGL2 fallback), and [Rapier](https://rapier.rs/) physics.

## Features

- Real physics-based flight and flips: momentum and gravity drive the motion, nothing is a pre-baked animation
- Flies over a small 3D village with buildings, roads and a pond
- Collides with the environment: buildings and terrain are solid
- Touch controls for phone; mouse and keyboard work on desktop
- Auto camera that follows the drone and eases back behind it, or drag/pinch for full manual control

## Controls

| Action | Touch | Keyboard |
| --- | --- | --- |
| Takeoff / Land | Takeoff, Land | `T` / `L` |
| Move | left pad | `W A S D` / arrows |
| Altitude | right pad ▲▼ | `Space` / `Shift` |
| Yaw | right pad ↺↻ | `Q` / `E` |
| Flip | Flip L, Flip R | `Z` / `X` |
| Orbit camera | drag anywhere on the scene | n/a |
| Zoom | pinch, wheel, or the top slider | n/a |
| Auto camera | **Auto Cam** toggle | n/a |

## Running locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Every push to `main` builds and deploys automatically, so no manual build/deploy steps are needed.

## Credits

- Drone model: [DJI Tello](https://sketchfab.com/3d-models/dji-tello-36365bad0ebd46428e6241676725dcec) on Sketchfab
- Environment: this work is based on ["chicken gun fruzer village"](https://sketchfab.com/3d-models/chicken-gun-fruzer-village-ff6c831d7b534d4395ba568021376208) by [amogusstrikesback2](https://sketchfab.com/amogusstrikesback2), licensed under [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/)
