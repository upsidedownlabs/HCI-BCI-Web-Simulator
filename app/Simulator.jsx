'use client';

import { useEffect } from 'react';

/**
 * Renders the simulator's DOM and starts it.
 *
 * The ids and `data-cmd` / `data-action` / `data-group` / `data-toggle` values
 * below are how UIManager finds each control — renaming one disables it. There
 * is no React state: SceneManager injects the canvas and UIManager mutates the
 * HUD directly, so this tree mounts once and is never re-rendered.
 */
export default function Simulator() {
  useEffect(() => {
    // Deferred to the client: main.js boots on import, looking up #app and
    // starting WebGPU and Rapier's wasm.
    let cancelled = false;
    let disposeSim = null;

    import('../src/main.js').then((mod) => {
      if (cancelled) {
        mod.dispose?.();
        return;
      }
      disposeSim = mod.dispose;
    });

    return () => {
      cancelled = true;
      // Releases the renderer, Rapier world and GPU buffers on a client-side
      // navigation, which pagehide/beforeunload never fire for.
      disposeSim?.();
    };
  }, []);

  return (
    <div id="app">
      {/* <canvas id="viewport"> is injected here by SceneManager */}

      <div id="overlay">
        {/* ------------------------------------------------------ HUD --- */}
        <div id="hud" className="panel">
          <div className="hud-head">
            <span className="hud-lamp" aria-hidden="true" />
            <span className="hud-label">Status</span>
            <span id="hud-state" className="hud-value--state" data-state="landed">
              Landed
            </span>
          </div>

          <div className="hud-grid">
            <div className="hud-cell">
              <span className="hud-label">Alt</span>
              <span id="hud-altitude" className="hud-value">
                0.00 m
              </span>
            </div>
            <div className="hud-cell">
              <span className="hud-label">Spd</span>
              <span id="hud-speed" className="hud-value">
                0.00 m/s
              </span>
            </div>
            <div className="hud-cell">
              <span className="hud-label">Hdg</span>
              <span id="hud-heading" className="hud-value">
                0°
              </span>
            </div>
          </div>

          <div className="hud-foot">
            <span className="hud-foot-item">
              <span className="hud-label">FPS</span>
              <span id="hud-fps" className="hud-value hud-value--sm">
                –
              </span>
            </span>
            <span className="hud-foot-item">
              <span className="hud-label">Renderer</span>
              <span id="hud-backend" className="hud-value hud-value--dim">
                …
              </span>
            </span>
          </div>
        </div>

        {/* ------------------------------------------ camera controls --- */}
        <div id="topbar" className="panel">
          <button
            type="button"
            id="btn-autocam"
            className="btn btn--toggle is-on"
            data-toggle="autoCamera"
            aria-pressed="true"
            aria-label="Auto camera adjustment"
          >
            <span className="btn-glyph">⟳</span>
            <span className="btn-text">Auto Cam</span>
            <span className="toggle-pip" />
          </button>

          <div className="zoom">
            <span className="zoom-icon" aria-hidden="true">
              −
            </span>
            {/* Uncontrolled on purpose — UIManager writes .value directly. */}
            <input
              id="zoom-slider"
              className="zoom-slider"
              type="range"
              min="0"
              max="1000"
              defaultValue={250}
              aria-label="Camera zoom"
            />
            <span className="zoom-icon" aria-hidden="true">
              +
            </span>
          </div>
        </div>

        {/* ------------------------------------------- flight actions --- */}
        <div id="actions" className="panel">
          <button
            type="button"
            className="btn btn--ghost"
            data-action="flipLeft"
            data-group="flip"
            aria-label="Flip left"
          >
            <span className="btn-glyph">↺</span>
            <span className="btn-text">Flip L</span>
          </button>
          {/* One button for both: UIManager swaps its label, glyph and colour
              with flight state. Takeoff when landed, Land when airborne. */}
          <button
            type="button"
            id="btn-flight"
            className="btn btn--primary"
            data-action="flight"
            data-group="flight"
            aria-label="Take off"
          >
            <span className="btn-glyph" data-flight-glyph="">
              ▲
            </span>
            <span className="btn-text" data-flight-text="">
              Takeoff
            </span>
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            data-action="flipRight"
            data-group="flip"
            aria-label="Flip right"
          >
            <span className="btn-glyph">↻</span>
            <span className="btn-text">Flip R</span>
          </button>

          {/* Child of #actions, not a sibling in the overlay grid, so it
              centres on the bar's own rendered width — the grid's left and
              right gutters aren't the same width (the HUD panel and the pad
              aren't the same size), so centring on the viewport instead
              leaves the toast visibly off from the button bar beneath it. */}
          <div id="toast" role="status" aria-live="polite" />
        </div>

        {/* --------------------------------- left stick: translation --- */}
        <div id="pad-left" className="pad panel">
          <span className="pad-title">Move</span>
          <div className="pad-grid">
            <button type="button" className="btn btn--pad pad-n" data-cmd="forward" aria-label="Forward">
              ▲
            </button>
            <button type="button" className="btn btn--pad pad-w" data-cmd="left" aria-label="Strafe left">
              ◀
            </button>
            <div className="pad-hub" aria-hidden="true" />
            <button type="button" className="btn btn--pad pad-e" data-cmd="right" aria-label="Strafe right">
              ▶
            </button>
            <button type="button" className="btn btn--pad pad-s" data-cmd="backward" aria-label="Backward">
              ▼
            </button>
          </div>
        </div>

        {/* -------------------------- right stick: altitude + heading --- */}
        <div id="pad-right" className="pad panel">
          <span className="pad-title">Alt / Yaw</span>
          <div className="pad-grid">
            <button type="button" className="btn btn--pad pad-n" data-cmd="up" aria-label="Ascend">
              ▲
            </button>
            <button type="button" className="btn btn--pad pad-w" data-cmd="yawLeft" aria-label="Rotate left">
              ↺
            </button>
            <div className="pad-hub" aria-hidden="true" />
            <button type="button" className="btn btn--pad pad-e" data-cmd="yawRight" aria-label="Rotate right">
              ↻
            </button>
            <button type="button" className="btn btn--pad pad-s" data-cmd="down" aria-label="Descend">
              ▼
            </button>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------- loader --- */}
      <div id="loader">
        <div className="loader-inner">
          <div className="loader-title">Tello Drone Simulator</div>
          <div className="loader-track">
            <div id="loader-bar" />
          </div>
          <div id="loader-text">Starting renderer…</div>
        </div>
      </div>
    </div>
  );
}
