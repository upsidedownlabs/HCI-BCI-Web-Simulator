/**
 * Drone specifications.
 *
 * Everything the physics and controller need to fly a given airframe lives in
 * one plain-data object. Swapping to another drone is a matter of adding an
 * entry here and passing a different `spec` to `DroneController` — no physics
 * code changes. The collider is derived at runtime from the loaded model's
 * bounding box, so geometry differences are handled automatically.
 *
 * This file intentionally has zero imports so it stays trivially serialisable
 * (e.g. loaded from JSON or a backend later).
 */

/** @typedef {typeof DRONE_PRESETS.tello} DroneSpec */

export const DRONE_PRESETS = {
  tello: {
    id: 'tello',
    name: 'DJI Tello',

    // ---- Asset -------------------------------------------------------------
    /** Resolved relative to the app base URL. Only thing you must change to swap models. */
    modelPath: 'dji_tello.glb',
    /** Largest horizontal dimension in metres. The loaded model is uniformly
     *  scaled to match, so authoring units (cm/inch/whatever) don't matter. */
    targetSpan: 0.18,
    /**
     * Yaw applied to the mesh so its nose faces -Z (Three.js "forward"), degrees.
     * Positive turns the nose left, negative turns it right — so this is 90°
     * right of the previous 180°. Visual only: the collider and every flight
     * axis are unaffected, so this is safe to nudge until it looks right.
     */
    modelYawOffsetDeg: 90,
    /**
     * Spin any node whose name matches, procedurally. Applied on top of the
     * node's authored rotation, so rigs with rotated prop hubs still spin about
     * their own axis. Takes priority over the model's own clips.
     */
    rotorNodePattern: 'pervane|prop|rotor|blade|fan',
    /**
     * Only used when no node name matches. Off for the Tello: its clip is a
     * 6.4 s spin-up/spin-down ramp with a 90° seam, so it reads as the props
     * repeatedly starting and stopping rather than turning continuously.
     */
    useModelAnimation: false,
    rotorSpinRate: 55, // rad/s at full thrust
    /**
     * Floor on rotor rate while airborne, as a fraction of `rotorSpinRate`.
     * Thrust adds on top; the sum never reaches zero in flight, so the blades
     * cannot appear to stall while the drone is holding altitude.
     */
    rotorIdle: 0.55,
    /** Time constant for the props to spool up or down, seconds. */
    rotorSpinUp: 0.35,

    // ---- Mass properties ---------------------------------------------------
    mass: 0.087, // kg
    linearDamping: 0.9,
    angularDamping: 1.2,

    // ---- Flight envelope ---------------------------------------------------
    hoverHeight: 1.0, // m AGL — the altitude TAKEOFF targets
    minAltitude: 0.25,
    maxAltitude: 45.0, // clears the warehouses (11 m) and radio tower
    /** Peak commanded bank/pitch angle, degrees. Also sets top speed via g·tan(θ). */
    maxTiltDeg: 15,
    /** Time constant for attitude to reach the commanded tilt, seconds. */
    tiltResponse: 0.12,
    /**
     * Auto-brake. With the sticks centred the drone leans *against* its
     * residual horizontal velocity, which is what a real Tello does when you
     * let go. Damping alone decays exponentially and leaves it drifting for
     * seconds; this brings it to a stop in about one.
     */
    brakeGainDegPerMs: 9, // degrees of counter-lean per m/s of drift
    maxBrakeDeg: 12,
    yawRateDeg: 100, // deg/s at full stick
    yawResponse: 0.15, // time constant of the yaw-rate torque controller

    climbRate: 1.0, // m/s on UP/DOWN
    takeoffClimbRate: 0.9,
    landingDescentRate: 0.55,
    /** Ceiling on thrust, expressed as a multiple of g. Tello is ~2g. */
    maxThrustG: 2.2,

    // ---- Altitude hold (cascaded P controller) -----------------------------
    altitudeGain: 2.6, // position error -> desired vertical speed
    verticalGain: 6.0, // velocity error -> acceleration

    // ---- Manoeuvres --------------------------------------------------------
    /**
     * Roll torque from differential rotor thrust, N·m. Four rotors at 0.47 N
     * each across a ~65 mm arm: slam the left pair to full and the right pair
     * to idle and you get 0.94 N × 0.065 m. That is the ceiling, not a tuning
     * knob — there is no more roll authority available.
     */
    flipTorque: 0.061,
    /**
     * Roll inertia as a fraction of the equivalent solid box.
     *
     * The collider is a  slab as wide as the propeller disc, and treating that
     * as uniformly dense is badly wrong for a quadcopter: nearly all the mass
     * is the battery and board at the hub, plus four small motors partway out,
     * while the props and arms that set the width weigh almost nothing.
     * Summing those properly for a Tello gives about 30% of the solid-box
     * figure, so the box formula was making the airframe roughly three times
     * harder to roll than it is — the flip took the same time however much
     * torque it was given, because it spent the whole rotation accelerating.
     */
    rollInertiaFactor: 0.3,
    /**
     * Firmware rate limit, rad/s.
     *
     * This is what sets the *shape* of the flip, and it is not free to choose.
     * The drone is unpowered from 90° to 270°, so the manoeuvre is a ballistic
     * arc, and an arc that peaks h metres up has to last 2·sqrt(2h/g) seconds —
     * gravity decides, not the animator. Spinning faster than that means the
     * rotation finishes while the drone is still on the way up, so it climbs
     * through the whole flip and then sinks back afterwards: a ramp and a float
     * rather than an arc.
     *
     * The `arc` phase buys some slack — the drone keeps coasting after the
     * rotation finishes, so the two no longer have to be the same length — but
     * not unlimited slack, because whatever the rotation does not cover is
     * flown level, and too much of that reads as a flip followed by a fall.
     *
     * 21 rad/s (3.3 rev/s) puts the rotation at ~0.25 s against a ~0.5 s arc,
     * so the drone is inverted near the top and back level on the way down.
     * The rotation does not wind up to this from a standstill — the entry roll
     * hands over already turning, and 823 rad/s² covers the rest in under two
     * frames, so the rate climbs continuously from the moment the flip starts.
     *
     * Pushing much past this starts to show: the rotation finishes so early
     * that the peak of the arc lands past 220° of roll, and the drone spends a
     * visible stretch level and still climbing before it comes back down.
     */
    flipMaxRate: 21,
    /**
     * Angular rate the brake aims for at 360°, rad/s, rather than a dead stop.
     * What is left over carries the airframe a little past level before
     * attitude hold springs it back — the follow-through a real quad shows
     * coming out of a flip. Braking to an exact standstill instead makes the
     * rotation simply stop, which is the tell of an animation.
     */
    flipExitRate: 5,
    /**
     * Ceiling on that overshoot, degrees.
     *
     * Not just a visual flourish — the exit phase has the throttle on, so the
     * bank genuinely steers thrust, giving a real, physical nudge the way the
     * drone flipped. Kept modest on purpose: pushed to 20° it read as its own
     * distinct shove rather than the flip's own momentum settling out. At 10°
     * it is a slight, legible kick rather than a second manoeuvre.
     */
    flipRecoilMaxDeg: 10,
    /**
     * How long the bank left by the rotation is allowed to drive the drone
     * unopposed, seconds. Short on purpose: this is the throw out of the flip,
     * and it has to land *on* the moment the roll completes. Sustained for
     * half a second the drive outlives the rotation that caused it and stops
     * reading as its consequence at all.
     *
     * It has to be inside the manoeuvre rather than left to decay on its own,
     * because with the sticks centred the auto-brake leans *against* the drift
     * and would cancel the kick before it could be seen.
     */
    flipKickTime: 0.16,
    /**
     * Total length of the exit, seconds — the kick above, then ordinary
     * altitude hold for the remainder, controls still locked out. It does not
     * need to cover the whole climb back to entry height: ordinary hold is the
     * same code every other height correction in the game uses, so a beat of
     * it finishing after control returns reads as normal flight, not as the
     * flip still running. This just has to outlast the kick and the worst of
     * the residual sink from the arc.
     */
    flipExitTime: 0.4,
    /**
     * Entry roll, degrees. The flip starts as an ordinary hard bank held at
     * full throttle, and this is how far over it goes before rotor torque takes
     * the rotation off attitude hold. It is the single knob that trades height
     * for distance: thrust acts along body-up, so at this angle the drone gets
     * `cos` of it as lift and `sin` of it as sideways push. Banking further
     * moves the flip across the room instead of ballooning it upward, which is
     * what a real Tello flip looks like.
     *
     * 68° with the entry time below lifts 1.7 spans before the rotation even
     * takes over, peaks at 2.4, and carries 8.5 spans across — where the
     * original 15° entry needed 4.7 spans of climb to move half as far.
     * Steeper than this trades that pre-flip climb away: at 80° only cos(80°)
     * of the thrust points up, so the drone barely rises before it is already
     * rolling. Steep is also what keeps the arc centred: the less of the
     * thrust that goes upward, the sooner the drone stops climbing, and the
     * closer the top of the arc lands to the top of the rotation.
     *
     * This being past a normal bank angle does not make it a separate pose —
     * the roll accelerates continuously from zero, so it simply sweeps through
     * on its way round. Nothing visually marks where the phase changes.
     */
    flipEntryTiltDeg: 68,
    /**
     * How long the entry bank is held, seconds. Together with the angle this
     * sets the whole altitude budget of the manoeuvre — the rest of the flip is
     * unpowered. Too long and the drone pops up and floats back down; too short
     * and it finishes below where it started. Retune this whenever `flipMaxRate`
     * changes: a faster rotation spends less time ballistic and so needs less
     * of a climb to come out level.
     *
     * This also has to be matched to `flipMaxRate`: it sets the vertical speed
     * the drone carries into the rotation, and therefore where in that rotation
     * the arc peaks. Too much and the drone is still climbing when it comes back
     * upright; the target is somewhere in the inverted half. At 0.25 s it peaks
     * at 257° of roll, so the drone is over the top and coming down before it
     * is level again — an arc, not a ramp.
     *
     * This is close to its ceiling. Much past 0.25 s and the peak lands at 360°
     * — the drone climbs through the entire flip and only comes down after it,
     * which is the ramp-and-float this manoeuvre keeps being pulled back from.
     * A steeper `flipEntryTiltDeg` buys a little more room here, because less
     * of the thrust goes into the climb that pushes the peak late.
     */
    flipEntryTime: 0.25,

    // ---- State machine tolerances ------------------------------------------
    hoverTolerance: 0.08, // m — how close to hoverHeight counts as "arrived"
    hoverSettleTime: 0.18, // s — must hold tolerance this long before FLYING
    touchdownHeight: 0.02, // m AGL that counts as ground contact
  },
};

/** Default airframe used when nothing is specified. */
export const DEFAULT_DRONE = 'tello';

export const WORLD = {
  gravity: 9.81,
  groundY: 0,
  /**
   * Soft wall, measured from the spawn. The village is 433 x 502 m, so this is
   * about exploring a neighbourhood rather than the whole map — raise it to
   * roam further.
   */
  arenaRadius: 120,
  /** Catch-all plane far below the terrain, so nothing can fall into the void. */
  safetyFloorY: -20,
};

/**
 * Village scene in public/chicken_gun_fruzer_village/.
 *
 * "chicken gun fruzer village" by amogusstrikesback2, CC-BY-4.0.
 * https://skfb.ly/pKnDv
 *
 * Measured from the asset: 227k triangles across 187 meshes, 14 materials,
 * 10 textures, and a 433 x 502 m footprint authored at roughly real-world
 * scale (warehouses ~28 m, doors ~3.5 m). No rescale is applied — an 18 cm
 * Tello in a real-sized village is the intended feel.
 */
export const ENVIRONMENT = {
  path: 'chicken_gun_fruzer_village/scene.gltf',
  /** 1 = keep authored metres. Lower this to shrink the world around the drone. */
  scale: 1,

  /** Spawn probe: a grid of downward rays over this radius about the centre. */
  spawnSearchRadius: 90,
  spawnSearchSteps: 26,
  /** Steepest face the drone may start on, and clear air needed above it. */
  maxSlopeNormalY: 0.9,
  spawnHeadroom: 12,

  /**
   * World-space grid cell size, metres, that render meshes are batched into
   * (see Environment._buildRenderBatches). Smaller cells cull more precisely
   * when flying far from spawn; larger cells mean fewer draw calls near
   * spawn, where most of the flight actually happens. 60 m keeps the soft
   * arena wall (radius 120) spanning about 4 cells across.
   */
  renderBatchChunkSize: 60,
};

/**
 * Rendering cues that communicate *altitude*.
 *
 * Without these a drone at 40 m and one at 1 m render almost identically: the
 * directional shadow map spans 90 m, so an 18 cm drone resolves to about two
 * texels and effectively casts nothing, and a uniformly sharp image gives the
 * eye no sense of scale or distance.
 */
export const RENDER = {
  /**
   * Explicit contact shadow drawn beneath the drone — one textured quad,
   * positioned from the ground probe the flight model already runs, so it lands
   * correctly on rooftops and vehicles rather than only on the ground plane.
   */
  contactShadow: {
    /** Radius at zero altitude, as a multiple of the drone's span. */
    baseRadius: 0.8,
    /** Extra radius per metre of altitude — a real penumbra spreads with height. */
    growth: 0.22,
    /** Opacity at zero altitude; falls off as 1/(1 + altitude·fade). */
    opacity: 0.55,
    fade: 0.12,
    /** Clearance above the surface, to avoid z-fighting on near-flat ground. */
    lift: 0.03,
  },

  /**
   * Depth of field focused on the drone. Holding the subject sharp while the
   * ground falls out of focus is the tilt-shift cue the eye reads as "seen from
   * high up". Full-screen and multi-pass, so `'desktop'` keeps it off phones,
   * where the 60 FPS budget matters more; `true`/`false` force it either way.
   */
  depthOfField: {
    /**
     * Off by default: measurably expensive (a full-screen multi-pass blur) and
     * it costs more than it buys here — the contact shadow and the altitude-
     * aware camera already carry the sense of height. Try it with `?dof=1`,
     * or set this to `'desktop'` / `true` to bring it back.
     */
    enabled: false,
    /** Focal plane; tracked each frame to the camera's distance to the drone. */
    focusDistance: 1,
    /**
     * Depth that stays sharp around that plane, in metres — absolute, not a
     * multiple of subject distance. Deriving it from the ~0.9 m chase distance
     * gave a ~2 m band, which blurred the entire village; only things well
     * beyond the immediate surroundings should soften.
     */
    focalLength: 45,
    /** Artistic bokeh size; higher blurs the far field harder. */
    bokehScale: 1.5,
  },
};

/**
 * Orbit camera. Distances are multiples of the drone's measured span, so the
 * framing holds for any airframe and the zoom limits always keep it readable.
 */
export const CAMERA = {
  defaultElevation: 0.36, // radians above the horizon
  minElevation: -0.28,
  maxElevation: 1.24, // just short of straight down (gimbal lock)

  /**
   * Default chase distance, as a multiple of the drone's span. 3.0 puts the
   * camera about half a metre behind an 18 cm Tello — over-the-shoulder rather
   * than observing from across the room, which is what sells the drone as
   * something you are flying rather than watching.
   */
  distanceSpans: 3.0,
  minDistanceSpans: 1.6, // closest — drone nearly fills the frame
  /**
   * Furthest, in metres rather than spans. A span-derived limit tops out around
   * 2.5 m, which is fine for inspecting the drone and useless for seeing the
   * village it is flying over. Zoom is exponential across the range.
   */
  maxDistanceMetres: 35,
  /**
   * Auto-cam tilts toward looking straight down as the drone climbs, reaching
   * `lookDownAmount` of the way to `maxElevation` at `lookDownAltitude`. Without
   * this a level chase view at altitude frames nothing but sky.
   */
  lookDownAltitude: 35,
  lookDownAmount: 0.75,

  /** Seconds of no touch/drag before an auto-adjusting camera returns home. */
  autoReturnDelay: 3.0,
  returnSmoothing: 2.2, // exponential rate of that return
  followSmoothing: 8, // how tightly the camera tracks the drone's position
  /**
   * Rate at which the viewpoint swings round to stay behind the drone once it
   * is already roughly there — separate from `returnSmoothing`, which governs
   * unwinding a large offset the user dragged in.
   *
   * These want opposite things from one number. Chasing a 100 deg/s yaw at
   * `returnSmoothing` trails by 45 degrees, so the world slews round well after
   * the drone has turned; but snapping a half-turn of user drag back at *this*
   * rate is a lurch. So the rate is blended between them by how far off the
   * camera currently is: tight tracking near home, a gentle ease from far out.
   * At 9 the steady-state lag while yawing is about 11 degrees — enough to feel
   * like a camera being carried rather than one welded to the airframe.
   */
  yawFollowSmoothing: 9,
  /** Offset beyond which the return is fully governed by `returnSmoothing`. */
  yawCatchUpAngle: 1.05, // radians (60 degrees)

  orbitSensitivity: 0.0062, // radians per pixel dragged
  wheelSensitivity: 0.0013, // zoom fraction per wheel unit
};
