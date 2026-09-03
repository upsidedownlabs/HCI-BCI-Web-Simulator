/**
 * Touch overlay + HUD.
 *
 * Buttons are declared in index.html with `data-cmd` (held: movement) or
 * `data-action` (one-shot: takeoff/land/flip). This module owns nothing but
 * wiring and enable/disable state, so the layout can be restyled freely.
 *
 * Pointer events are used rather than touch/mouse pairs, with pointer capture
 * so a finger that slides off a button still delivers `pointerup` to it —
 * without that, movement inputs stick on.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Which buttons are live in each drone state. */
function computeEnabled(status) {
  const flying = status.state === 'flying' && !status.isFlipping;
  const landed = status.state === 'landed';
  return {
    // Merged Takeoff/Land control: live at both ends of the state machine,
    // locked through the transitions between them.
    flight: landed || flying,
    // Kept for layouts that still split the two into separate buttons.
    takeoff: landed,
    land: flying,
    move: flying,
    flip: flying,
  };
}

const KEY_BINDINGS = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'up',
  ShiftLeft: 'down',
  KeyQ: 'yawLeft',
  KeyE: 'yawRight',
};

const KEY_ACTIONS = {
  // Takeoff and Land are one merged button (`data-action="flight"`) — main.js
  // decides which of the two it means from the drone's current state. Mapping
  // either key to the old, no-longer-existing 'takeoff'/'land' action names
  // left `_buttonFor` unable to find a matching button, silently swallowing
  // both keys.
  KeyT: 'flight',
  KeyL: 'flight',
  KeyZ: 'flipLeft',
  KeyX: 'flipRight',
};

export class UIManager {
  /**
   * @param {object} opts
   * @param {(command:string, active:boolean)=>void} opts.onCommand
   * @param {(action:string)=>void} opts.onAction
   * @param {(dx:number, dy:number)=>void} [opts.onOrbit] drag delta in pixels
   * @param {(factor:number)=>void} [opts.onZoomBy] multiplicative zoom
   * @param {(t:number)=>void} [opts.onZoomSet] absolute zoom, 0..1
   * @param {(name:string, on:boolean)=>void} [opts.onToggle]
   * @param {HTMLElement} [opts.root]
   */
  constructor({ onCommand, onAction, onOrbit, onZoomBy, onZoomSet, onToggle, root = document }) {
    this.onCommand = onCommand;
    this.onAction = onAction;
    this.onOrbit = onOrbit ?? (() => {});
    this.onZoomBy = onZoomBy ?? (() => {});
    this.onZoomSet = onZoomSet ?? (() => {});
    this.onToggle = onToggle ?? (() => {});
    this.root = root;

    this.els = {
      overlay: root.querySelector('#overlay'),
      loader: root.querySelector('#loader'),
      loaderBar: root.querySelector('#loader-bar'),
      loaderText: root.querySelector('#loader-text'),
      state: root.querySelector('#hud-state'),
      altitude: root.querySelector('#hud-altitude'),
      speed: root.querySelector('#hud-speed'),
      heading: root.querySelector('#hud-heading'),
      fps: root.querySelector('#hud-fps'),
      backend: root.querySelector('#hud-backend'),
      toast: root.querySelector('#toast'),
    };

    /** @type {HTMLButtonElement[]} */
    this.buttons = Array.from(root.querySelectorAll('[data-cmd], [data-action]'));
    /** Buttons currently held, so we can release them if they get disabled. */
    this.held = new Set();
    this._listeners = [];
    this._lastKey = new Set();
    this._toastTimer = 0;

    /** Active pointers on the camera surface, keyed by pointerId. */
    this._camPointers = new Map();
    this._pinchDistance = 0;
    this._zoomSlider = root.querySelector('#zoom-slider');

    // Merged Takeoff/Land button, if the layout uses one.
    this._flight = root.querySelector('[data-group="flight"]');
    this._flightGlyph = this._flight?.querySelector('[data-flight-glyph]');
    this._flightText = this._flight?.querySelector('[data-flight-text]');
    this._flightShowsLand = null;

    this._bindButtons();
    this._bindToggles();
    this._bindCameraGestures();
    this._bindKeyboard();
    this._bindGlobalGuards();
  }

  _bindToggles() {
    this.toggles = Array.from(this.root.querySelectorAll('[data-toggle]'));
    for (const button of this.toggles) {
      this._on(button, 'pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const on = !button.classList.contains('is-on');
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-pressed', String(on));
        this.onToggle(button.dataset.toggle, on);
      });
    }

    if (this._zoomSlider) {
      const max = Number(this._zoomSlider.max) || 1000;
      // The slider reads as magnification, not distance: right (+) zooms in.
      // The camera API is distance-based (0 = closest), so invert here — this
      // is presentation, and the scene shouldn't care which way a widget runs.
      this._on(this._zoomSlider, 'input', () => {
        this.onZoomSet(1 - Number(this._zoomSlider.value) / max);
      });
      // The slider lives inside the camera surface; don't let it start a drag.
      this._on(this._zoomSlider, 'pointerdown', (e) => e.stopPropagation());
    }
  }

  /**
   * Drag to orbit, wheel or pinch to zoom. Bound to the whole app surface —
   * the overlay is `pointer-events: none` except on its panels, so gestures on
   * empty space reach here while taps on controls are filtered out below.
   */
  _bindCameraGestures() {
    const surface = this.root.getElementById?.('app') ?? this.root.querySelector('#app');
    if (!surface) return;
    this._surface = surface;

    const isControl = (target) =>
      target instanceof Element && target.closest('.panel, button, input');

    this._on(surface, 'pointerdown', (e) => {
      if (isControl(e.target)) return;
      this._camPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._camPointers.size === 2) this._pinchDistance = this._pinchSpan();
    });

    this._on(
      surface,
      'pointermove',
      (e) => {
        const prev = this._camPointers.get(e.pointerId);
        if (!prev) return;
        e.preventDefault();

        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        prev.x = e.clientX;
        prev.y = e.clientY;

        if (this._camPointers.size >= 2) {
          // Two fingers: pinch to zoom, ignore rotation to keep it predictable.
          const span = this._pinchSpan();
          if (this._pinchDistance > 0 && span > 0) {
            this.onZoomBy(this._pinchDistance / span);
          }
          this._pinchDistance = span;
        } else {
          this.onOrbit(dx, dy);
        }
      },
      { passive: false },
    );

    const end = (e) => {
      this._camPointers.delete(e.pointerId);
      if (this._camPointers.size < 2) this._pinchDistance = 0;
    };
    this._on(surface, 'pointerup', end);
    this._on(surface, 'pointercancel', end);
    this._on(surface, 'pointerleave', end);

    this._on(
      surface,
      'wheel',
      (e) => {
        if (isControl(e.target)) return;
        e.preventDefault();
        // Exponential so each notch feels the same at any distance.
        this.onZoomBy(Math.exp(e.deltaY * 0.0013));
      },
      { passive: false },
    );
  }

  _pinchSpan() {
    const [a, b] = [...this._camPointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * Push the camera's current zoom back onto the slider, so wheel, pinch and
   * the auto-return all keep it in step. Driven from the throttled HUD tick.
   */
  syncZoom(t) {
    if (!this._zoomSlider || t === undefined) return;
    const max = Number(this._zoomSlider.max) || 1000;
    // `t` is 0 = closest; the slider runs the other way (see the input handler).
    this._zoomSlider.value = String(Math.round((1 - t) * max));
  }

  _on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push([target, type, handler, options]);
  }

  _bindButtons() {
    for (const button of this.buttons) {
      const command = button.dataset.cmd;
      const action = button.dataset.action;

      if (action) {
        // Fire on pointerdown for responsiveness; `click` adds ~100ms on touch.
        this._on(button, 'pointerdown', (e) => {
          if (button.disabled) return;
          e.preventDefault();
          button.classList.add('is-active');
          this.onAction(action);
        });
        const clear = () => button.classList.remove('is-active');
        this._on(button, 'pointerup', clear);
        this._on(button, 'pointercancel', clear);
        this._on(button, 'pointerleave', clear);
        continue;
      }

      if (!command) continue;

      this._on(button, 'pointerdown', (e) => {
        if (button.disabled) return;
        e.preventDefault();
        try {
          button.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort */
        }
        this._press(button, command);
      });

      const release = () => this._release(button, command);
      this._on(button, 'pointerup', release);
      this._on(button, 'pointercancel', release);
      // Fallback for browsers where capture silently fails.
      this._on(button, 'lostpointercapture', release);
    }
  }

  _press(button, command) {
    if (this.held.has(button)) return;
    this.held.add(button);
    button.classList.add('is-active');
    this.onCommand(command, true);
  }

  _release(button, command) {
    if (!this.held.delete(button)) return;
    button.classList.remove('is-active');
    this.onCommand(command, false);
  }

  _bindKeyboard() {
    this._on(window, 'keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey) return;

      const command = KEY_BINDINGS[e.code];
      if (command) {
        e.preventDefault();
        if (!this._lastKey.has(e.code)) {
          this._lastKey.add(e.code);
          const button = this._buttonFor('cmd', command);
          if (button && !button.disabled) this._press(button, command);
        }
        return;
      }

      const action = KEY_ACTIONS[e.code];
      if (action) {
        e.preventDefault();
        const button = this._buttonFor('action', action);
        if (button && !button.disabled) this.onAction(action);
      }
    });

    this._on(window, 'keyup', (e) => {
      const command = KEY_BINDINGS[e.code];
      if (!command) return;
      this._lastKey.delete(e.code);
      const button = this._buttonFor('cmd', command);
      if (button) this._release(button, command);
    });
  }

  _bindGlobalGuards() {
    // Releasing everything on blur/hide prevents a stuck throttle when the user
    // switches apps mid-hold.
    const panic = () => this.releaseAll();
    this._on(window, 'blur', panic);
    this._on(document, 'visibilitychange', () => {
      if (document.hidden) panic();
    });
    // Kill iOS double-tap zoom and long-press callouts over the controls.
    this._on(
      this.els.overlay,
      'touchstart',
      (e) => {
        if (e.target.closest('button')) e.preventDefault();
      },
      { passive: false },
    );
    this._on(this.els.overlay, 'contextmenu', (e) => e.preventDefault());
  }

  _buttonFor(kind, value) {
    return this.buttons.find((b) => b.dataset[kind] === value) ?? null;
  }

  releaseAll() {
    for (const button of Array.from(this.held)) {
      this._release(button, button.dataset.cmd);
    }
    this._lastKey.clear();
  }

  /**
   * Enable/disable buttons for the current flight state. Runs every frame —
   * it only touches the DOM when a button's state actually flips, so it's
   * effectively free, and lockout can't lag behind the simulation the way it
   * would on the throttled HUD tick.
   *
   * @param {ReturnType<import('./DroneController.js').DroneController['getStatus']>} status
   */
  syncControls(status) {
    const enabled = computeEnabled(status);

    for (const button of this.buttons) {
      const group = button.dataset.group ?? 'move';
      const shouldEnable = enabled[group] ?? false;
      if (button.disabled === !shouldEnable) continue;

      button.disabled = !shouldEnable;
      // A button disabled while held would never receive pointerup.
      if (!shouldEnable && this.held.has(button)) {
        this._release(button, button.dataset.cmd);
      }
    }

    this._syncFlightButton(status);
  }

  /**
   * Swap the merged control between Takeoff and Land. It flips as soon as the
   * drone leaves the ground (while disabled), so by the time it re-enables in
   * steady flight it already reads "Land".
   */
  _syncFlightButton(status) {
    const button = this._flight;
    if (!button) return;

    const showLand = status.state !== 'landed';
    if (this._flightShowsLand === showLand) return;
    this._flightShowsLand = showLand;

    button.classList.toggle('btn--primary', !showLand);
    button.classList.toggle('btn--danger', showLand);
    button.setAttribute('aria-label', showLand ? 'Land' : 'Take off');
    if (this._flightGlyph) this._flightGlyph.textContent = showLand ? '▼' : '▲';
    if (this._flightText) this._flightText.textContent = showLand ? 'Land' : 'Takeoff';
  }

  /** Text readouts only. Throttled by the caller — DOM writes aren't free. */
  update(status, { fps, backend } = {}) {
    this.syncControls(status);
    const els = this.els;
    els.state.textContent = LABELS[status.state] ?? status.state;
    els.state.dataset.state = status.isFlipping ? 'flipping' : status.state;
    els.altitude.textContent = `${status.altitude.toFixed(2)} m`;
    els.speed.textContent = `${status.speed.toFixed(2)} m/s`;
    els.heading.textContent = `${Math.round(status.headingDeg)}°`;
    if (fps !== undefined) els.fps.textContent = String(Math.round(fps));
    if (backend) els.backend.textContent = backend;
  }

  setProgress(fraction) {
    // Belt-and-suspenders clamp: loader progress is assembled from several
    // asset-load callbacks upstream, and a browser progress event's own
    // loaded/total ratio isn't guaranteed to stay within [0, 1] to begin with
    // (see Loaders.js). Never worth showing the pilot a percentage over 100.
    const pct = Math.round(clamp01(fraction) * 100);
    this.els.loaderBar.style.width = `${pct}%`;
    this.els.loaderText.textContent = `Loading airframe… ${pct}%`;
  }

  hideLoader() {
    this.els.loader.classList.add('is-hidden');
    this.els.overlay.classList.add('is-ready');
  }

  showError(message) {
    this.els.loader.classList.remove('is-hidden');
    this.els.loaderBar.style.width = '100%';
    this.els.loader.classList.add('is-error');
    this.els.loaderText.textContent = message;
  }

  toast(message, ms = 1600) {
    const el = this.els.toast;
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('is-visible'), ms);
  }

  dispose() {
    this.releaseAll();
    clearTimeout(this._toastTimer);
    for (const [target, type, handler, options] of this._listeners) {
      target.removeEventListener(type, handler, options);
    }
    this._listeners.length = 0;
    this.buttons.length = 0;
  }
}

const LABELS = {
  landed: 'Landed',
  takingOff: 'Taking off',
  flying: 'In flight',
  landing: 'Landing',
};
