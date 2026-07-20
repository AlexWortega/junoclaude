#!/usr/bin/env node
// Autopilot: drives a flight through the JunoBridge HTTP API.
//
// Flying by hand through one-off HTTP calls does not work — a launch needs
// decisions several times a second, and a round trip through the chat is far
// too slow. So the control loop lives here, and only the outcome is reported.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JUNO_BRIDGE ?? 'http://127.0.0.1:7842';
const TOKEN_FILE = join(
  homedir(),
  'Library/Application Support/com.jundroo.SimpleRockets2/junobridge.token'
);

let token = '';

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (!json.ok && json.error?.code !== undefined) {
    const err = new Error(`${json.error.code}: ${json.error.message ?? ''}`);
    err.code = json.error.code;
    throw err;
  }
  return json.data;
}

const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b ?? {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The planet's radius, needed to turn the orbit's apsis *distances* into
 * altitudes. It is not served directly, but every telemetry frame carries both
 * the planet-centred position and the altitude above sea level, and the
 * difference of the two is the radius. Measured once on the pad: 1274.2 km for
 * Droo.
 */
let planetRadius = null;

function vecLength(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (v) => {
  const l = vecLength(v);
  return l === 0 ? [0, 0, 0] : scale(v, 1 / l);
};

/**
 * The local vertical, as a unit vector in the same frame as the attitude basis.
 *
 * `attitude.north`/`east` and `position.pci` share a frame — on the pad the
 * normalised pci vector is perpendicular to both to within the site's 0.11° of
 * latitude — so the zenith is simply the normalised position. Deriving it as a
 * cross product of north and east instead would leave the sign ambiguous,
 * because the game's coordinate system is left-handed.
 */
const zenithOf = (t) => unit(t.pci);

/**
 * Which body axis is the nose.
 *
 * `attitude.pitch` is aircraft pitch of the craft's *forward* axis, so a rocket
 * standing on the pad reports ~0° rather than 90°: steering on it commanded a
 * 90° error and laid the vehicle over before it cleared the pad. For a stack
 * built along Y the thrust axis is the craft's `up`, but rather than assume it,
 * pick whichever body axis is aligned with the vertical while still on the pad.
 */
function findNoseAxis(t) {
  const z = zenithOf(t);
  const candidates = ['up', 'forward', 'right'];
  let best = 'up';
  let bestDot = -Infinity;
  for (const name of candidates) {
    const d = Math.abs(dot(unit(t.att[name]), z));
    if (d > bestDot) {
      bestDot = d;
      best = name;
    }
  }
  return { axis: best, alignment: bestDot, sign: dot(unit(t.att[best]), z) >= 0 ? 1 : -1 };
}

/** Telemetry flattened to the handful of numbers the loop actually steers on. */
function digest(t) {
  if (planetRadius === null && Array.isArray(t.position.pci))
    planetRadius = vecLength(t.position.pci) - t.position.altitudeAsl;

  // The orbit is reported as distances from the planet's centre, under the
  // names apoapsisDistance/periapsisDistance. Reading `orbit.apoapsis` gets the
  // apsis *position vector* instead, so the altitude cutoff never once fired.
  const orbit = t.orbit?.valid === true ? t.orbit : null;
  const asAltitude = (d) => (orbit === null || planetRadius === null ? null : d - planetRadius);

  return {
    altitude: t.position.altitudeAsl,
    agl: t.position.altitudeAgl,
    vertical: t.velocity.vertical,
    surfaceSpeed: t.velocity.surfaceMagnitude,
    orbitalSpeed: t.velocity.orbitalMagnitude,
    pitch: t.attitude.pitch,
    bank: t.attitude.bank,
    forward: t.attitude.forward,
    thrust: t.propulsion.currentThrust,
    maxThrust: t.propulsion.maxThrust,
    engines: t.propulsion.activeEngineCount,
    twr: t.propulsion.twr,
    fuel: t.mass.fuel,
    stageFuel: t.mass.remainingFuelInStage,
    stage: t.state.currentStage,
    numStages: t.state.numStages,
    parts: t.state.partCount,
    grounded: t.state.grounded,
    apoapsis: orbit === null ? null : asAltitude(orbit.apoapsisDistance),
    periapsis: orbit === null ? null : asAltitude(orbit.periapsisDistance),
    timeToApoapsis: orbit === null ? null : orbit.timeToApoapsis,
    eccentricity: orbit === null ? null : orbit.eccentricity,
    angular: t.velocity.angular,
    // Surface velocity as a vector: the gravity turn steers onto it.
    velocityVector: t.velocity.surface,
    // The attitude basis is kept raw so the steering law and any later
    // calibration work from vectors rather than from aircraft-frame angles.
    att: t.attitude,
    pci: t.position.pci,
  };
}

/** Angle in degrees between the nose and the local vertical: 0 is straight up. */
function tiltFromVertical(t, nose) {
  const n = scale(unit(t.att[nose.axis]), nose.sign);
  return (Math.acos(Math.max(-1, Math.min(1, dot(n, zenithOf(t))))) * 180) / Math.PI;
}

/**
 * Command that best rotates the nose towards an aim direction.
 *
 * Nothing here is derived from the frame's geometry. The calibration pulse
 * measures the angular velocity the craft actually produces per unit command,
 * and that vector *is* the achievable rotation axis — stored in body
 * coordinates, where it is constant, and rebuilt in the world frame each
 * sample. The command is the least-squares projection of the wanted angular
 * velocity onto it.
 *
 * Every earlier attempt tried to reason the rotation sense out of cross
 * products and got it wrong in some geometries, silently: the game's frame is
 * left-handed and the craft's roll at spawn varies, so two runs measured
 * +0.0558 and -0.0553 rad/s for the same command.
 *
 * The aim is a direction, not an angle, so the error is the angle between nose
 * and aim: in [0,180], zero when correct, and continuous — unlike a signed
 * tilt, whose jumps drove the measured rate to 1160 deg/s.
 */
function bodyToWorld(t, v) {
  return add(
    add(scale(unit(t.att.right), v[0]), scale(unit(t.att.up), v[1])),
    scale(unit(t.att.forward), v[2])
  );
}

function steerToward(t, nose, aim, axes, gain) {
  const n = scale(unit(t.att[nose.axis]), nose.sign);
  const a = unit(aim);
  const errRad = Math.acos(Math.max(-1, Math.min(1, dot(n, a))));
  const errDeg = (errRad * 180) / Math.PI;

  // All three inputs, measured, and solved exactly.
  //
  // The input names do not describe what they do to this craft: "pitch" was
  // measured at [0.477, -0.944, -0.108] with the nose along `up`, so 95% of it
  // rotates the vehicle about its own long axis — roll, in rocket terms. Two
  // such axes cannot point the nose at all; weighting roll down only traded a
  // stalled slew for a craft spinning up to 0.39 rad/s. With all three
  // calibrated the matrix is square, so the wanted rotation — including a roll
  // rate of exactly zero — is solved rather than approximated.
  const P = bodyToWorld(t, axes.pitch);
  const Y = bodyToWorld(t, axes.yaw);
  const R = bodyToWorld(t, axes.roll);

  const wanted = scale(cross(n, a), gain.rate);
  const omega = t.angular ?? [0, 0, 0];
  // Close on the rate error with a first-order time constant. The axes are in
  // rad/s² per unit command, so this asks for an acceleration and the solve
  // returns the command that produces it.
  const b = scale(add(wanted, scale(omega, -1)), gain.bandwidth);

  // Cramer's rule on [P Y R] x = b.
  const det = dot(P, cross(Y, R));
  if (Math.abs(det) < 1e-9) return { pitch: 0, yaw: 0, roll: 0, errDeg };
  let cp = (dot(b, cross(Y, R)) / det) * gain.damp;
  let cy = (dot(P, cross(b, R)) / det) * gain.damp;
  let cr = (dot(P, cross(Y, b)) / det) * gain.damp;

  // Scale the whole solution rather than clipping each component. Cramer's rule
  // gives an exact answer only as a set; clamping one axis on its own bends the
  // resulting rotation away from the one asked for, and the roll axis is weak
  // enough (magnitude 0.32 against pitch's 1.09) that it saturates first and
  // drags the other two off course.
  const peak = Math.max(Math.abs(cp), Math.abs(cy), Math.abs(cr));
  if (peak > gain.clamp) {
    const k = gain.clamp / peak;
    cp *= k;
    cy *= k;
    cr *= k;
  }

  return { pitch: cp, yaw: cy, roll: cr, errDeg };
}

function steerCommand(t, nose, tiltDeg, azimuthUnit, gain, polarity) {
  // Chase the target no more than a right angle at a time. `axis = n × target`
  // has magnitude sin(error), so beyond 90° the term shrinks again and past a
  // point the projection changes sign: a flight commanded to 140° sat at
  // cmd 0.000 while the tilt slid the wrong way, from 61° back to 6°, with the
  // loop believing it was holding the requested rate.
  const current = tiltFromVertical(t, nose);
  const capped = Math.max(current - 80, Math.min(current + 80, tiltDeg));
  const rad = (capped * Math.PI) / 180;
  const target = unit(
    add(scale(zenithOf(t), Math.cos(rad)), scale(azimuthUnit, Math.sin(rad)))
  );
  const n = scale(unit(t.att[nose.axis]), nose.sign);
  const axis = cross(n, target);

  // A pitch input rotates the craft about its `right` axis and a yaw input
  // about the axis perpendicular to both that and the nose, so the required
  // rotation is commanded by projecting onto exactly those two.
  //
  // The input is a *torque*, not a rate: a constant 0.4 held on pitch spun the
  // craft through 180° and kept going. So the loop is a cascade — the angle
  // error sets a wanted turn rate, and the command closes on that rate using
  // the measured angular velocity. Proportional control on angle alone
  // oscillates against a double integrator.
  //
  // Polarity is measured in flight, not derived: the game's frame is
  // left-handed and the sign of the input is not documented. Holding pitch at
  // +0.4 swung the nose north while `dot(n × north, right)` was −1, which fixes
  // the pitch channel at −1.
  const other = ['up', 'forward', 'right'].find((a) => a !== nose.axis && a !== 'right');
  const clamp = (x) => Math.max(-1, Math.min(1, x));
  const omega = t.angular ?? [0, 0, 0];

  // The angle error sets a wanted turn rate, and the command closes on that
  // rate. Both gains have to stay small: holding 0.12 built up 0.22 rad/s in
  // three seconds, so at four samples a second a hot gain saturates the axis
  // and the vehicle tumbles. An earlier attempt with rate 0.3 and damp 5 did
  // exactly that, and diverged identically at *both* polarities — the gain was
  // the fault, not the sign.
  const limit = gain.clamp ?? 1;
  const channel = (bodyAxis, sign) => {
    const a = unit(bodyAxis);
    const wanted = gain.rate * dot(axis, a); // rad/s asked for about this axis
    const c = sign * gain.damp * (wanted - dot(omega, a));
    return Math.max(-limit, Math.min(limit, c));
  };

  return {
    pitch: channel(t.att.right, polarity.pitch),
    yaw: channel(t.att[other], polarity.yaw),
    tilt: tiltFromVertical(t, nose),
  };
}

async function waitForFlight(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await get('/status');
    if (s.scene === 'flight' && s.hasCraft && !s.transitioning) return s;
    await sleep(1000);
  }
  throw new Error('The flight scene did not come up in time');
}

/**
 * A launch profile: full throttle, stage when the current stage runs dry, and
 * hold the nose up. Returns a trace so the caller can see what happened rather
 * than only where it ended.
 */
/**
 * Target tilt away from the local vertical during ascent, in degrees: 0 is
 * straight up, 90 is on the horizon.
 *
 * Climbing straight up spends the whole budget fighting gravity, so the vehicle
 * tips over gradually with altitude — vertical until it is clear of the pad,
 * then easing towards the horizon as it thins out of the atmosphere.
 *
 * This is measured against the *vertical*, not the aircraft-frame `pitch`
 * telemetry: a rocket standing on the pad reports a pitch near 0, so a profile
 * expressed in that field would ask for a 90° change and lay the vehicle over.
 */
/**
 * Throttle needed to hold the thrust-to-weight ratio at a cap, while still in
 * air thick enough to matter.
 *
 * Running a light upper stage at full thrust drives the ratio to 5 and beyond,
 * which puts the vehicle through 900 m/s at 13 km — deep in the region of
 * highest dynamic pressure. The three-stage vehicle flipped there: the loop had
 * held the tilt at 7° with a near-zero command for thirty seconds, then
 * saturated and lost it in three. Holding the ratio down keeps the speed low
 * while the air is thick, which cuts both the aerodynamic torque and the drag
 * loss. Above the atmosphere there is nothing to gain by holding back.
 */
function throttleFor(t, cap) {
  if (t.twr <= 0) return 1;
  // Release the cap gradually. Ending it at a fixed altitude tripled the thrust
  // between two samples, and the step kicked a gimballed engine hard enough to
  // start the tumble that ended the previous flight.
  const release = Math.max(0, Math.min(1, (t.altitude - 30000) / 15000));
  const effective = cap + release * 20;
  return Math.max(0.4, Math.min(1, effective / t.twr));
}

/**
 * Tilt the ascent should have reached by a given altitude.
 *
 * The turn only begins above the atmosphere. Inside it the airframe is
 * unstable — engine-heavy, no fins — and *any* control input starts a
 * divergence it cannot recover from: commands of both polarities drove the tilt
 * from 0 to 170° within twenty seconds, while flying with the input held at
 * exactly zero reached 82 km dead straight. Turning high costs gravity loss,
 * which this vehicle has the margin to pay; fins would be the real fix.
 *
 * Following prograde alone is self-limiting: if the vehicle never turns, the
 * velocity stays vertical and so does the target, which is how a flight reached
 * 79 km of apoapsis still only 8° from vertical and with almost no horizontal
 * speed. The schedule forces the turn open; prograde is then used as a floor so
 * the nose never falls behind the trajectory it is already on.
 */
function scheduledTiltDeg(altitude) {
  const table = [
    [8000, 5],
    [15000, 15],
    [25000, 32],
    [40000, 52],
    [60000, 70],
    [85000, 85],
    [110000, 90],
  ];
  if (altitude <= table[0][0]) return 0;
  for (let i = 1; i < table.length; i++) {
    const [aHi, tHi] = table[i];
    const [aLo, tLo] = table[i - 1];
    if (altitude <= aHi) return tLo + ((altitude - aLo) / (aHi - aLo)) * (tHi - tLo);
  }
  return 90;
}

/** Angle of the surface velocity vector from the local vertical, in degrees. */
function progradeTiltDeg(t) {
  const v = t.velocityVector ?? [0, 0, 0];
  if (vecLength(v) < 1) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(unit(v), zenithOf(t))))) * 180) / Math.PI;
}

async function ascend({
  durationS = 120,
  sampleMs = 50,
  targetApoapsis = null,
  gravityTurn = false,
  turnStart = 8000,
  engageDeg = 12,
  releaseDeg = 3,
  insertionApoapsis = 95000,
  insertionAltitude = 60000,
  turnEnd = 45000,
  trace = [],
  started = Date.now(),
  probe = null,
  polarity = { pitch: 1, yaw: 1 },
  kickTiltDeg = 10,
  gains = { rate: 0.06, damp: 2, clamp: 0.06 },
  twrCap = 2.2,
}) {
  let nose = null;
  let azimuth = [0, 0, 0];
  let lastStageAt = 0;
  let stallSince = null;
  let lastParts = null;
  let frozen = null;
  let frozenSince = null;
  let drySince = null;
  let holdingPitch = false;
  let steering = false;

  await post('/flight/input', { mode: 'hold', throttle: 1 });
  // Throttle alone does nothing: the first stage still has to be activated,
  // which is what ignites the engine.
  await post('/flight/stage', {});
  lastStageAt = 0.5;

  while ((Date.now() - started) / 1000 < durationS) {
    let t;
    try {
      t = digest(await get('/telemetry'));
    } catch (e) {
      // The craft can be destroyed mid-flight; that is an outcome, not a crash.
      trace.push({ t: (Date.now() - started) / 1000, error: e.code ?? e.message });
      if (e.code === 'no_craft' || e.code === 'wrong_scene') break;
      await sleep(sampleMs);
      continue;
    }

    const sample = { t: Number(((Date.now() - started) / 1000).toFixed(1)), ...t };
    trace.push(sample);

    const elapsed = (Date.now() - started) / 1000;

    // Tilt from vertical and downrange bearing, recorded on every sample: these
    // are what the steering law works on, and what a calibration run reads back.
    if (nose !== null) {
      sample.tilt = Number(tiltFromVertical(t, nose).toFixed(1));
      const n = scale(unit(t.att[nose.axis]), nose.sign);
      sample.noseEast = Number(dot(n, unit(t.att.east)).toFixed(4));
      sample.noseNorth = Number(dot(n, unit(t.att.north)).toFixed(4));
    }

    // Losing parts without commanding it means a joint broke. Snapshot what is
    // left while it is still in the scene — after the flight ends the evidence
    // is gone, and the part list says whether a decoupler *fired* or *tore*
    // (`activated` is false when it tore).
    if (lastParts !== null && t.parts < lastParts && elapsed - lastStageAt > 1.5) {
      const survivors = await get('/craft/parts').catch(() => null);
      trace.push({
        t: elapsed,
        note: `lost ${lastParts - t.parts} parts without a staging command`,
        survivors: survivors?.parts?.map((p) => ({
          id: p.partId,
          type: p.partType,
          stage: p.activationStage,
          activated: p.activated,
        })),
      });
    }
    lastParts = t.parts;

    // Stage when the burning stage runs dry, with a cooldown so a single dry
    // reading cannot burn through every stage at once.
    //
    // The old test was `fuel <= 0.01` on the craft's *total* fuel, which on a
    // multi-stage vehicle is never true — the upper tanks are still full — so
    // it never staged. A dry stage shows up instead as thrust collapsing while
    // the throttle is still open.
    // The last stage is the parachute; staging into it during ascent throws
    // away the recovery system and leaves nothing to circularise with, which is
    // exactly what happened on the first flight to reach 90 km of apoapsis.
    // A freshly lit engine reads zero thrust for a second or two while it
    // spools up. With a 2.5 s cooldown that read as "still dry" and staged
    // again, throwing away a full stage 2.5 s after separating the one below
    // it. Requiring several consecutive dry samples, and a longer cooldown,
    // distinguishes an engine that is starting from one that is finished.
    // Time, not samples. These thresholds were written when the loop ran at
    // 4 Hz, where three samples meant 0.75 s; at 20 Hz they meant 0.15 s, and a
    // momentary dip in thrust staged the vehicle during the climb.
    if (t.thrust >= 1 && t.stageFuel > 0.01) drySince = null;
    else drySince ??= elapsed;
    if (drySince !== null && elapsed - drySince > 0.75 && t.stage < t.numStages - 1 && elapsed > 3 && elapsed - lastStageAt > 6) {
      await post('/flight/stage', {});
      lastStageAt = elapsed;
      drySince = null;
      trace.push({ t: elapsed, note: `staged to ${t.stage + 1}/${t.numStages}` });
    }

    // Establish the body frame once, while the vehicle is still standing on the
    // pad and its nose is unambiguously vertical.
    if (nose === null && t.grounded) {
      nose = findNoseAxis(t);
      // Launch due north: the pitch channel is the calibrated one, and `right`
      // lies along the east-west axis, so pitch alone tilts the nose northward.
      azimuth = unit(t.att.north);
      trace.push({
        t: elapsed,
        note: `nose axis "${nose.axis}" sign ${nose.sign} (alignment ${nose.alignment.toFixed(3)})`,
      });
    }

    if (nose !== null && !t.grounded) {
      // Calibration: hold a fixed command and let the caller read back how the
      // nose actually moved, which fixes the sign of each input axis.
      if (probe !== null && elapsed > probe.after) {
        await post('/flight/input', { mode: 'hold', throttle: 1, ...probe.input });
      } else if (gravityTurn) {
        // Pitch over once, then let go.
        //
        // Closing an attitude loop from here does not work: the control input
        // is a torque strong enough to spin the craft 180° in 4.5 s, while this
        // loop only samples twice a second over HTTP. Both polarities diverged
        // identically — the delay, not the sign, is what makes it unstable.
        //
        // A gravity turn does not need the loop. The vehicle holds attitude on
        // its own (it flew straight up for 90 s with no input at all), so one
        // brief kick sets a tilt and the local vertical rotates out from under
        // the craft as it flies downrange, opening the turn by itself.
        const tilt = tiltFromVertical(t, nose);
        sample.tilt = Number(tilt.toFixed(1));

        // Turn in the plane the pitch axis can actually reach.
        //
        // A pitch command rotates the nose about `right`, so the nose only ever
        // moves within the plane perpendicular to it. Aiming at a target picked
        // from the horizontal component of the velocity put the target outside
        // that plane — the velocity is still almost straight up when the turn
        // begins, so its horizontal part is near zero and points anywhere — and
        // the required rotation fell almost entirely on the axis that is never
        // commanded. The result was a command of 0.000 against a 78° error for
        // fifty seconds. Deriving the azimuth from the craft's own geometry
        // instead keeps the whole manoeuvre on the pitch axis.
        const reach = cross(unit(t.att.right), scale(unit(t.att[nose.axis]), nose.sign));
        const horizontal = (() => {
          const z = zenithOf(t);
          const h = add(reach, scale(z, -dot(reach, z)));
          if (vecLength(h) < 1e-6) return azimuth;
          // Of the two directions pitch can reach, take the one that carries
          // the nose downrange rather than back the way it came.
          const east = unit(h);
          const v = t.velocityVector ?? [0, 0, 0];
          const vh = add(v, scale(z, -dot(v, z)));
          return vecLength(vh) > 20 && dot(east, vh) < 0 ? scale(east, -1) : east;
        })();

        // Hold prograde once the turn has begun: that is what a gravity turn
        // is, and it keeps the angle of attack near zero. The kick floor gets
        // it started, since prograde is still straight up at that moment.
        // While the apoapsis is still being raised, follow the schedule. Once
        // it is high enough the job changes: the remaining thrust has to both
        // add horizontal speed and slowly bleed off the climb, so the nose
        // goes just past the horizon. Only just: asking for 140° made the slew
        // overshoot to 173°, which pointed the thrust backwards and collapsed
        // the horizontal speed from 457 to 169 m/s. Near 90° is where the
        // horizontal speed actually accumulates.
        const wanted =
          t.altitude < turnStart
            ? 0
            : t.apoapsis !== null &&
                t.apoapsis > insertionApoapsis &&
                t.altitude > insertionAltitude
              ? 90 + Math.max(0, Math.min(12, t.vertical / 80))
              : Math.min(90, scheduledTiltDeg(t.altitude));

        sample.wantTilt = Number(wanted.toFixed(1));

        // Only override the pitch axis while actually steering, and release it
        // otherwise.
        //
        // `mode: "hold"` does not mean "no input" when the value is zero: it
        // pins the axis every frame and so switches off the game's own
        // stability assist. That is what destabilised every steered flight —
        // both polarities ran the tilt from 0 to 170° in twenty seconds, while
        // flights that never posted a pitch value at all flew dead straight to
        // 82 km. Passing null releases the axis back to the game.
        // Slew with the axis held, then hand the attitude back to the game.
        //
        // Overriding an axis switches off the game's own stability assist, and
        // the assist holds the craft's attitude: with the axis released the
        // vehicle flew 90 s dead straight, and while a weak command fought it
        // the tilt stayed pinned at 7° against a 60° demand. Both behaviours
        // are useful, in different phases. Slewing needs the assist out of the
        // way; burning needs it holding the nose still, which the loop cannot
        // do on a light upper stage — the tilt oscillated 87°→170°→35° once the
        // craft was down to 37 kg.
        //
        // So: engage to slew when well off target, release once close, and do
        // not re-engage until it has drifted well off again. Without the gap
        // between the two thresholds the assist re-centres the craft on every
        // other sample and the turn never opens.
        const error = Math.abs(tilt - wanted);
        if (steering && error < releaseDeg) steering = false;
        else if (!steering && error > engageDeg) steering = true;

        if (t.altitude < turnStart || !steering) {
          if (holdingPitch) {
            await post('/flight/input', { mode: 'hold', throttle: 1, pitch: null });
            holdingPitch = false;
          }
        } else {
          const cmd = steerCommand(t, nose, wanted, horizontal, gains, polarity);
          sample.cmdPitch = Number(cmd.pitch.toFixed(3));
          sample.throttle = throttleFor(t, twrCap);
          holdingPitch = true;
          await post('/flight/input', {
            mode: 'hold',
            throttle: sample.throttle,
            pitch: cmd.pitch,
          });
        }
      }
    }

    if (targetApoapsis !== null && t.apoapsis !== null && t.apoapsis >= targetApoapsis) {
      await post('/flight/input', { mode: 'hold', throttle: 0 });
      trace.push({ t: elapsed, note: `apoapsis ${(t.apoapsis / 1000).toFixed(1)}km reached, cutting off` });
      break;
    }

    // A destroyed craft does not report an error: the telemetry simply freezes
    // on its last values. Detect the freeze rather than polling it for minutes.
    if (frozen !== null && t.altitude === frozen.altitude && t.surfaceSpeed === frozen.surfaceSpeed) {
      frozenSince ??= elapsed;
      if (elapsed - frozenSince > 3) {
        trace.push({ t: elapsed, note: 'aborted: telemetry frozen, craft is gone' });
        break;
      }
    } else {
      frozenSince = null;
    }
    frozen = t;

    // Falling back towards the ground is over: riding it down to the crash only
    // costs cycle time, and every flight here takes minutes.
    if (!t.grounded && t.altitude < 3000 && t.vertical < -40 && elapsed > 15) {
      trace.push({
        t: elapsed,
        note: `aborted: falling back at ${t.vertical.toFixed(0)} m/s below 3 km`,
      });
      break;
    }

    // Not climbing while under thrust means the vehicle is lying over or stuck:
    // burning the rest of the fuel into the ground teaches us nothing.
    if (!t.grounded && t.thrust > 0 && t.vertical < 1 && !gravityTurn) {
      stallSince ??= elapsed;
      if (elapsed - stallSince > 6) {
        trace.push({ t: elapsed, note: 'aborted: thrust without climb' });
        break;
      }
    } else {
      stallSince = null;
    }

    await sleep(sampleMs);
  }

  return { trace, lastParts, nose };
}

/**
 * Coast to apoapsis and burn horizontally until periapsis clears the
 * atmosphere.
 *
 * Cutting the throttle at the target apoapsis leaves a trajectory whose
 * periapsis is still underground — it is a ballistic arc, not an orbit. The
 * only thing that raises periapsis is adding horizontal speed at apoapsis, so
 * this phase holds the nose on the horizon and burns there.
 */
async function circularise({
  trace,
  targetPeriapsis,
  durationS,
  sampleMs = 50,
  startedAt,
  nose,
  polarity,
  gains = { rate: 0.06, damp: 2, clamp: 0.06 },
  engageDeg = 10,
  releaseDeg = 3,
  burnThrottle = Number(process.env.JUNO_BURN_THROTTLE ?? 0.5),
}) {
  const elapsedNow = () => (Date.now() - startedAt) / 1000;
  let burning = false;
  let steering = false;
  let holdingPitch = false;
  let lastStageAt = elapsedNow();
  let drySince = null;
  let frozen = null;
  let frozenSince = null;
  // The pitch polarity is measured once, with a calibration pulse at the start
  // of the coast, and then never changed.
  //
  // It cannot be derived reliably: the command enters as a torque about the
  // craft's `right` axis, the desired rotation comes from `n × target`, and
  // whether those agree in sign depends on the handedness of the game's frame,
  // which is left-handed. Getting it wrong fails *silently* — the loop reports
  // cmd -0.001, believing it holds the commanded rate, while the nose slides
  // from 78° to 6° and the horizontal speed collapses from 1119 to 640 m/s.
  //
  // Measuring it from the ongoing response instead was tried and chatters: on a
  // craft that is already oscillating it reads the oscillation, not the sign,
  // and flipped twelve times in forty seconds. A single pulse during the coast
  // has none of that trouble — there is no thrust, no air and no hurry.
  // Everything here is controlled in the one scalar that matters, the tilt from
  // vertical, whose target is unambiguously 90°. The earlier law built its
  // command from `dot(n × target, right)`, and that projection's sign depends on
  // the frame's handedness and on the craft's roll at spawn — two calibration
  // runs measured +0.0558 and -0.0553 rad/s for the *same* command. Calibrating
  // d(tilt)/d(cmd) directly sidesteps all of it: it is measured per flight, in
  // the same scalar the loop steers on.
  let sign = polarity.pitch;
  let calibration = { state: 'calibrating', index: 0, at: null, omega0: [0, 0, 0], settleAt: null, startedAt: null, cmd: 0.08 };
  let axes = { pitch: [0, 0, 0], yaw: [0, 0, 0], roll: [0, 0, 0] };
  let prevTilt = null;
  let prevAt = null;
  let stillFor = 0;
  let burnStartedAt = null;
  let growingFor = 0;
  let prevError = null;

  const rateAboutRight = (t) => dot(t.angular ?? [0, 0, 0], unit(t.att.right));

  await post('/flight/input', { mode: 'hold', throttle: 0 });

  while (elapsedNow() < durationS) {
    let t;
    try {
      t = digest(await get('/telemetry'));
    } catch (e) {
      trace.push({ t: elapsedNow(), error: e.code ?? e.message });
      if (e.code === 'no_craft' || e.code === 'wrong_scene') break;
      await sleep(sampleMs);
      continue;
    }

    const elapsed = elapsedNow();
    const sample = { t: Number(elapsed.toFixed(1)), phase: 'circularise', ...t };
    trace.push(sample);

    // A destroyed craft freezes its telemetry rather than erroring; without
    // this the loop polled a dead vehicle for ten minutes.
    if (frozen !== null && t.altitude === frozen.altitude && t.surfaceSpeed === frozen.surfaceSpeed) {
      frozenSince ??= elapsed;
      if (elapsed - frozenSince > 3) {
        trace.push({ t: elapsed, note: 'aborted: telemetry frozen, craft is gone' });
        break;
      }
    } else {
      frozenSince = null;
    }
    frozen = t;

    if (t.apoapsis === null) {
      trace.push({ t: elapsed, note: 'orbit went invalid during coast' });
      break;
    }
    if (t.periapsis >= targetPeriapsis) {
      await post('/flight/input', { mode: 'hold', throttle: 0, pitch: null });
      trace.push({
        t: elapsed,
        note: `ORBIT: periapsis ${(t.periapsis / 1000).toFixed(1)}km apoapsis ${(t.apoapsis / 1000).toFixed(1)}km`,
      });
      break;
    }
    if (t.altitude < 20000 && t.vertical < -100) {
      trace.push({ t: elapsed, note: 'aborted: re-entered before circularising' });
      break;
    }

    // Point along the horizon, in the direction the craft is already moving.
    // At apoapsis every newton spent this way goes into raising periapsis, and
    // the target is a single fixed direction rather than a moving schedule —
    // which is the whole reason for coasting up here first.
    const tilt = tiltFromVertical(t, nose);

    // Calibrate all three inputs, then damp out what the pulses left.
    //
    // Each pulse takes the *difference* in angular velocity across it, so the
    // craft does not have to be brought to rest in between. Nulling between
    // pulses was tried and failed: with only one axis known at a time the null
    // could not cancel an off-axis spin, timed out, and the next pulse then
    // measured the leftover rotation instead of its own — yaw and roll came
    // back with byte-identical axes, and the whole calibration ate 160 s of a
    // coast that only had 200.
    if (calibration.state !== 'done') {
      if (calibration.startedAt === null) calibration.startedAt = elapsed;
      const omega = t.angular ?? [0, 0, 0];
      const ORDER = ['pitch', 'yaw', 'roll'];
      // A lit engine gimbals far harder than the command pod's own torque, so
      // the same pulse that is gentle in coast is violent under thrust: one
      // mid-burn recalibration left the craft at 4.17 rad/s, or 239°/s. Scale
      // the pulse down when there is thrust.
      const PULSE_S = t.thrust > 1 ? 0.5 : 1.2;
      calibration.cmd = t.thrust > 1 ? 0.015 : 0.08;

      if (calibration.index < ORDER.length) {
        const axis = ORDER[calibration.index];
        if (calibration.at === null) {
          calibration.at = elapsed;
          calibration.omega0 = omega;
        } else if (elapsed - calibration.at >= PULSE_S) {
          // Angular *acceleration* per unit command, not the velocity the pulse
          // happened to accumulate. Dividing by the pulse length matters: the
          // raw difference scales with it, so shortening the pulse from 2.5 s
          // to 1.2 s silently doubled every command the solver produced and the
          // craft tumbled at 1.5 rad/s with the inputs pinned to their limits.
          const d = scale(add(omega, scale(calibration.omega0, -1)), 1 / (calibration.cmd * PULSE_S));
          axes[axis] = [
            dot(d, unit(t.att.right)),
            dot(d, unit(t.att.up)),
            dot(d, unit(t.att.forward)),
          ];
          trace.push({
            t: elapsed,
            note: `${axis} axis (body) = [${axes[axis]
              .map((x) => x.toFixed(3))
              .join(', ')}] rad/s² per unit command`,
          });
          calibration.index += 1;
          calibration.at = null;
        }
        const zeros = { pitch: 0, yaw: 0, roll: 0 };
        const held = calibration.at === null ? zeros : { ...zeros, [axis]: calibration.cmd };
        // Keep burning through a mid-flight recalibration: the pulses perturb
        // the attitude by a degree or two, which is far cheaper than shutting
        // the engine down near apoapsis.
        await post('/flight/input', { mode: 'hold', throttle: burning ? burnThrottle : 0, ...held });
        await sleep(sampleMs);
        continue;
      }

      // Now that all three are known, damp the accumulated rotation with the
      // full solver rather than one axis at a time.
      if (calibration.settleAt === null) calibration.settleAt = elapsed;
      const spinning = vecLength(omega);
      // Do not hand over while still tumbling. The craft arrives from the climb
      // already spinning — separation imparts it and the climb flies with the
      // axes released, so nothing damps it — and one run entered the slew at
      // 0.45 rad/s because the settle gave up after 20 s. The coast is minutes
      // long; spending up to a minute here is cheap next to steering a tumbling
      // vehicle through the whole burn.
      sample.settleSpin = Number(spinning.toFixed(4));
      if (spinning < 0.02 || elapsed - calibration.settleAt > 60) {
        calibration.state = 'done';
        await post('/flight/input', {
          mode: 'hold',
          throttle: 0,
          pitch: null,
          yaw: null,
          roll: null,
        });
        holdingPitch = false;
        trace.push({
          t: elapsed,
          note: `calibration done in ${(elapsed - calibration.startedAt).toFixed(1)}s, residual ${spinning.toFixed(4)} rad/s`,
        });
      } else {
        const stop = steerToward(
          t,
          nose,
          scale(unit(t.att[nose.axis]), nose.sign), // aim at where it already points
          axes,
          { rate: 0, bandwidth: 1.2, damp: 1, clamp: 0.6 }
        );
        sample.cmdPitch = Number(stop.pitch.toFixed(4));
        await post('/flight/input', {
          mode: 'hold',
          throttle: burning ? burnThrottle : 0,
          pitch: stop.pitch,
          yaw: stop.yaw,
          roll: stop.roll,
        });
      }
      await sleep(sampleMs);
      continue;
    }

    // Start the burn half a burn-length before apoapsis, so it straddles the
    // high point instead of running almost entirely past it.
    //
    // A fixed 25 s lead was far too short: this vehicle needs minutes of thrust
    // to make orbital speed, so essentially the whole burn happened after
    // apoapsis and simply pushed apoapsis higher — one flight watched it climb
    // from 200 km to 1445 km while periapsis barely moved. The length is
    // estimated from the speed still to find and the acceleration available,
    // both of which are in telemetry.
    if (!burning && t.timeToApoapsis !== null && t.apoapsis !== null) {
      const rApo = (planetRadius ?? 0) + t.apoapsis;
      const MU = 9.81 * (planetRadius ?? 1) ** 2;
      const vCirc = Math.sqrt(MU / rApo);
      const horiz = Math.sqrt(Math.max(0, t.surfaceSpeed ** 2 - t.vertical ** 2));
      const deficit = Math.max(0, vCirc - horiz);
      const accel = t.twr > 0 ? t.twr * 9.81 * burnThrottle : 1;
      const burnSeconds = Math.min(400, deficit / Math.max(0.5, accel));
      sample.burnLead = Number(burnSeconds.toFixed(0));
      if (t.timeToApoapsis < burnSeconds / 2) {
        burning = true;
        burnStartedAt = elapsed;
        trace.push({
          t: elapsed,
          note:
            `circularisation burn at ${(t.altitude / 1000).toFixed(0)}km, ` +
            `${deficit.toFixed(0)} m/s to find, ~${burnSeconds.toFixed(0)}s of thrust`,
        });
      }
    }

    // Aim at one vector: the horizon, in the direction of travel. Angle and
    // azimuth are then a single quantity with no discontinuity, which is what
    // the previous attempts got wrong — a scalar tilt is direction-blind, and
    // signing it introduced jumps that made the measured rate reach 1160 deg/s
    // and pin the command at its limit.
    // Horizontal prograde, taken from the orbit rather than from the current
    // velocity direction. Near the top of a steep arc the horizontal component
    // of the velocity is tiny — 32 m/s on one flight — so using it directly
    // gives a noisy aim that wanders, and the slew chased it instead of
    // converging. The orbital plane's normal is stable, and the in-plane
    // horizontal direction follows from it.
    const z = zenithOf(t);
    const rv = t.pci;
    const vv = t.velocityVector ?? [0, 0, 0];
    const normal = cross(rv, vv);
    const inPlane = cross(normal, rv);
    const aim = vecLength(inPlane) > 1e-6 ? unit(inPlane) : unit(cross(z, unit(t.att.right)));

    // Gains follow measured thrust, not commanded: the engine takes a second or
    // two to answer, and until it does the only actuator is the pod's torque.
    const thrusting = t.thrust > 1;
    // The rate demand has to be one the clamp can actually deliver, or the
    // solution saturates and the loop bang-bangs: asking 0.25 rad/s when a
    // command of 0.12 produces about 0.13 left it pinned at the limit, spinning
    // up and then fighting its own spin, with the error drifting 87° to 101°
    // instead of closing. The least-squares solution is already the exact
    // command, so damp stays at 1 and the aggressiveness lives in the rate.
    // Slow and monotonic beats fast and oscillating. At 0.12 the loop swung the
    // error 100° -> 49° -> 106° with a period of about 20 s, which is what an
    // under-damped rate loop does when it is sampled four times a second over a
    // network; at 0.05 it closed steadily at roughly 0.8°/s and never
    // overshot. The coast is lengthened instead to give that rate time to work.
    // The loop runs at 20 Hz, not the 4 Hz assumed for most of this work. The
    // bridge round trip was never measured until late: a telemetry read is
    // 17 ms and an input write another 17, so a 50 ms period has headroom. The
    // 250 ms sample interval was an arbitrary constant, and every conclusion
    // drawn about "4 Hz being the limit" rested on it. With five times the
    // bandwidth the rate demand can be far more aggressive without the
    // under-damped swinging that a slow loop produced.
    const gain = thrusting
      ? { rate: 0.06, bandwidth: 0.5, damp: 1, clamp: 0.25 }
      : { rate: 0.10, bandwidth: 0.5, damp: 1, clamp: 0.3 };

    const steer = steerToward(t, nose, aim, axes, gain);
    const error = steer.errDeg;
    sample.tilt = Number(tiltFromVertical(t, nose).toFixed(1));
    sample.aimError = Number(error.toFixed(1));

    // Under a non-zero command the error must shrink. If it grows instead, say
    // so: steering the wrong way while reporting no error is the failure this
    // loop has had twice, and it cost several flights each time.
    if (steering && prevError !== null && error > prevError + 0.05) {
      if (++growingFor === 20)
        trace.push({
          t: elapsed,
          note: `WARNING: aim error growing under command (${prevError.toFixed(1)}° -> ${error.toFixed(1)}°)`,
        });
    } else if (steering) growingFor = 0;
    prevError = steering ? error : null;

    if (steering && error < (thrusting ? 1.5 : 0.5)) steering = false;
    else if (!steering && error > (thrusting ? 4 : 2)) steering = true;

    const throttle = burning ? burnThrottle : 0;
    if (steering) {
      sample.cmdPitch = Number(steer.pitch.toFixed(4));
      sample.cmdYaw = Number(steer.yaw.toFixed(4));
      sample.cmdRoll = Number(steer.roll.toFixed(4));
      holdingPitch = true;
      await post('/flight/input', {
        mode: 'hold',
        throttle,
        pitch: steer.pitch,
        yaw: steer.yaw,
        roll: steer.roll,
      });
    } else {
      await post('/flight/input', {
        mode: 'hold',
        throttle,
        ...(holdingPitch ? { pitch: null, yaw: null, roll: null } : {}),
      });
      holdingPitch = false;
    }

    // Only a burning engine can run dry; during the coast the thrust is zero
    // because the throttle is shut, which is not a reason to stage.
    // A freshly commanded engine reads zero thrust for a second or two while it
    // spools up. Counting that as a dry stage staged twice within 6.2 s at the
    // start of one burn, throwing away two stages and leaving the 1432 N third
    // stage to do the whole insertion. Wait for the engine to answer first.
    const settled = burnStartedAt !== null && elapsed - burnStartedAt > 4;
    if (!(burning && settled && (t.thrust < 1 || t.stageFuel <= 0.01))) drySince = null;
    else drySince ??= elapsed;
    if (drySince !== null && elapsed - drySince > 0.75 && t.stage < t.numStages - 1 && elapsed - lastStageAt > 6) {
      await post('/flight/stage', {});
      lastStageAt = elapsed;
      drySince = null;
      burnStartedAt = elapsed;
      // The calibrated axes describe the vehicle that was measured. Dropping a
      // stage changes the mass, the inertia and which engine is gimballing, and
      // the old axes then steer the wrong way: one burn held the aim inside 25°
      // until it staged, then lost it to 93° within twenty seconds. Re-measure.
      calibration.state = 'calibrating';
      calibration.index = 0;
      calibration.at = null;
      calibration.settleAt = null;
      calibration.startedAt = null;
      trace.push({
        t: elapsed,
        note: `staged to ${t.stage + 1}/${t.numStages}, recalibrating axes`,
      });
    }

    await sleep(sampleMs);
  }
  return trace;
}

/**
 * Measures how the craft responds to each control input, by pulsing them.
 *
 * Returns the angular acceleration per unit command for pitch, yaw and roll, in
 * body coordinates where it is constant. Everything that steers uses this
 * rather than reasoning about the frame: the game is left-handed, the input
 * names do not describe what they do to a given craft — "pitch" measured 95%
 * roll on this one — and the craft's roll at spawn varies between flights.
 *
 * Pulses take the *difference* in angular velocity, so the craft need not be
 * brought to rest between them.
 */
async function calibrateAxes({ trace, startedAt, sampleMs, throttle = 0, pulseS = 1.2, cmd = 0.08 }) {
  const elapsedNow = () => (Date.now() - startedAt) / 1000;
  const axes = { pitch: [0, 0, 0], yaw: [0, 0, 0], roll: [0, 0, 0] };
  const zeros = { pitch: 0, yaw: 0, roll: 0 };

  for (const axis of ['pitch', 'yaw', 'roll']) {
    let omega0 = null;
    const began = elapsedNow();
    while (elapsedNow() - began < pulseS + 0.5) {
      const t = digest(await get('/telemetry'));
      const omega = t.angular ?? [0, 0, 0];
      if (omega0 === null) omega0 = omega;
      if (elapsedNow() - began >= pulseS) {
        const d = scale(add(omega, scale(omega0, -1)), 1 / (cmd * pulseS));
        axes[axis] = [
          dot(d, unit(t.att.right)),
          dot(d, unit(t.att.up)),
          dot(d, unit(t.att.forward)),
        ];
        trace.push({
          t: elapsedNow(),
          note: `${axis} axis (body) = [${axes[axis].map((x) => x.toFixed(3)).join(', ')}] rad/s² per unit command`,
        });
        break;
      }
      await post('/flight/input', { mode: 'hold', throttle, ...zeros, [axis]: cmd });
      await sleep(sampleMs);
    }
  }
  await post('/flight/input', { mode: 'hold', throttle, ...zeros });
  return axes;
}

/**
 * Powered descent to a soft touchdown.
 *
 * The attitude demand is the easy one — straight up, which is the vehicle's
 * naturally stable attitude and the only one this loop holds reliably — and the
 * work is done by the throttle instead. Descent rate is commanded as a function
 * of height, fast when there is room and slowing to a crawl near the ground, and
 * the throttle closes on that. A first-order loop on descent rate is well within
 * what four samples a second can hold, unlike an attitude loop.
 *
 * It costs more than a suicide burn, which is the right trade here: the vehicle
 * measured 11450 m/s of Δv against roughly 4600 to orbit.
 */
async function descend({
  trace,
  startedAt,
  durationS,
  nose,
  axes,
  sampleMs = 50,
  touchdownSpeed = 3,
}) {
  const elapsedNow = () => (Date.now() - startedAt) / 1000;
  let landed = false;
  let warnedThrust = false;

  while (elapsedNow() < durationS) {
    let t;
    try {
      t = digest(await get('/telemetry'));
    } catch (e) {
      trace.push({ t: elapsedNow(), error: e.code ?? e.message });
      if (e.code === 'no_craft' || e.code === 'wrong_scene') break;
      await sleep(sampleMs);
      continue;
    }

    const elapsed = elapsedNow();
    const sample = { t: Number(elapsed.toFixed(1)), phase: 'descend', ...t };
    trace.push(sample);

    if (t.grounded && Math.abs(t.vertical) < 1) {
      landed = true;
      await post('/flight/input', { mode: 'hold', throttle: 0, pitch: null });
      trace.push({
        t: elapsed,
        note: `TOUCHDOWN at ${Math.abs(t.vertical).toFixed(2)} m/s`,
      });
      break;
    }

    // Commanded descent rate: room to fall high up, a crawl near the ground.
    const height = Math.max(0, t.agl);
    const wantedDescent = -Math.min(60, Math.max(touchdownSpeed, 0.35 * height));
    const error = wantedDescent - t.vertical; // positive means "slow the fall"
    // Feed forward the throttle that exactly hovers, then correct around it.
    // `twr` is quoted at full throttle, so its reciprocal is the hover setting
    // and it tracks the craft getting lighter as it burns. A fixed guess of 0.5
    // instead leaves the proportional term to make up a large steady offset,
    // which saturates it and turns a smooth descent into bang-bang.
    const hover = t.twr > 0.05 ? Math.min(1, 1 / t.twr) : 0.5;
    const throttle = Math.max(0, Math.min(1, hover + error * 0.04));
    sample.wantedDescent = Number(wantedDescent.toFixed(1));
    sample.throttle = Number(throttle.toFixed(3));

    // Say so rather than ride it into the ground: at full throttle and less
    // than unit thrust-to-weight there is no descent rate this loop can hold,
    // and the arithmetic below would keep asking politely all the way down.
    if (throttle > 0.98 && t.twr > 0 && t.twr < 1 && height < 2000 && !warnedThrust) {
      warnedThrust = true;
      trace.push({
        t: elapsed,
        note: `WARNING: full throttle at TWR ${t.twr.toFixed(2)} — cannot arrest the descent`,
      });
    }

    // Hold the nose on the local vertical, using the same measured-axis solver
    // as the insertion burn. Straight up is the easiest aim there is — it has no
    // azimuth to get wrong — but the *command* still has to come from measured
    // response rather than a guessed sign.
    const steer = steerToward(t, nose, zenithOf(t), axes, {
      rate: 0.08,
      bandwidth: 0.5,
      damp: 1,
      clamp: 0.25,
    });
    sample.tilt = Number(steer.errDeg.toFixed(1));

    if (steer.errDeg > 1.5) {
      await post('/flight/input', {
        mode: 'hold',
        throttle,
        pitch: steer.pitch,
        yaw: steer.yaw,
        roll: steer.roll,
      });
    } else {
      await post('/flight/input', { mode: 'hold', throttle, pitch: null, yaw: null, roll: null });
    }

    await sleep(sampleMs);
  }

  if (!landed) trace.push({ t: elapsedNow(), note: 'descent ended without touchdown' });
  return trace;
}

function summarise(trace) {
  const points = trace.filter((p) => p.altitude !== undefined);
  if (points.length === 0) return 'no telemetry collected';

  const first = points[0];
  const peak = points.reduce((a, b) => (b.altitude > a.altitude ? b : a));
  const last = points[points.length - 1];
  const notes = trace.filter((p) => p.note !== undefined || p.error !== undefined);

  const lines = [
    `samples ${points.length}, duration ${last.t}s`,
    `start   alt ${first.altitude.toFixed(1)}m  parts ${first.parts}  fuel ${first.fuel.toFixed(0)}`,
    `peak    alt ${peak.altitude.toFixed(1)}m at t+${peak.t}s  vertical ${peak.vertical.toFixed(1)}m/s`,
    `end     alt ${last.altitude.toFixed(1)}m  parts ${last.parts}  fuel ${last.fuel.toFixed(0)}  stage ${last.stage}/${last.numStages}`,
    `climb   ${(peak.altitude - first.altitude).toFixed(1)}m`,
  ];
  const withOrbit = points.filter((p) => p.apoapsis !== null);
  const bestPeriapsis = withOrbit.reduce((a, b) => (b.periapsis > a.periapsis ? b : a), withOrbit[0]);
  if (bestPeriapsis !== undefined)
    lines.push(
      `orbit   apoapsis ${(bestPeriapsis.apoapsis / 1000).toFixed(1)}km ` +
        `periapsis ${(bestPeriapsis.periapsis / 1000).toFixed(1)}km ` +
        `ecc ${bestPeriapsis.eccentricity.toFixed(3)} at t+${bestPeriapsis.t}s`
    );
  for (const n of notes) {
    lines.push(`note    t+${Number(n.t).toFixed(1)}: ${n.note ?? n.error}`);
    if (n.survivors !== undefined)
      lines.push(
        ...n.survivors.map(
          (s) => `        left: ${s.type} id=${s.id} stage=${s.stage} activated=${s.activated}`
        )
      );
  }
  return lines.join('\n');
}

async function main() {
  const [craftId, location = 'DSC Large Pad', durationRaw = '90'] = process.argv.slice(2);
  if (craftId === undefined) {
    console.error('usage: fly.mjs <craftId> [launchLocation] [durationSeconds]');
    process.exit(1);
  }

  token = (await readFile(TOKEN_FILE, 'utf8')).trim();

  // A scene transition left over from a previous flight rejects every command,
  // so wait it out rather than failing the run.
  let status = await get('/status');
  for (let i = 0; i < 40 && status.transitioning; i++) {
    await sleep(2000);
    status = await get('/status');
  }
  console.error(`bridge ok, scene=${status.scene}`);

  await post('/flight/launch', { craftId, launchLocation: location });
  await waitForFlight();

  // Telemetry stays unavailable for a moment after the scene settles; retry
  // rather than treating the gap as a failure.
  let before;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    try {
      before = digest(await get('/telemetry'));
      break;
    } catch {
      /* still settling */
    }
  }
  if (before === undefined) throw new Error('Telemetry never became available after launch');
  console.error(
    `on pad: alt ${before.altitude.toFixed(1)}m agl ${before.agl.toFixed(1)}m ` +
      `pitch ${before.pitch.toFixed(1)}° parts ${before.parts} fuel ${before.fuel.toFixed(0)}`
  );

  const started = Date.now();
  const durationS = Number(durationRaw);

  // A hop: climb to a set height, then land again. It exercises the descent
  // law against real ground without waiting for a whole mission to Luna, which
  // is the only other way to find out whether it can touch down softly.
  if (process.env.JUNO_MODE === 'hop') {
    const ceiling = Number(process.env.JUNO_HOP_CEILING ?? 1500);
    const trace = [];
    let nose = null;
    await post('/flight/input', { mode: 'hold', throttle: 1 });
    await post('/flight/stage', {});
    while ((Date.now() - started) / 1000 < durationS) {
      const t = digest(await get('/telemetry'));
      trace.push({ t: Number(((Date.now() - started) / 1000).toFixed(1)), ...t });
      if (nose === null && t.grounded) nose = findNoseAxis(t);
      if (t.agl >= ceiling) {
        await post('/flight/input', { mode: 'hold', throttle: 0 });
        trace.push({ t: (Date.now() - started) / 1000, note: `ceiling ${ceiling} m reached` });
        break;
      }
      await sleep(250);
    }
    const axes = await calibrateAxes({ trace, startedAt: started, sampleMs: 50 });
    await descend({
      trace,
      startedAt: started,
      durationS,
      nose: nose ?? { axis: 'up', sign: 1 },
      axes,
    });
    await post('/flight/input', { mode: 'clear' }).catch(() => {});
    console.log(summarise(trace));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await (await import('node:fs/promises')).writeFile(
      `/tmp/juno-hop-${craftId.replace(/\W+/g, '_')}-${stamp}.json`,
      JSON.stringify(trace, null, 2)
    );
    return;
  }

  const targetApoapsis = process.env.JUNO_TARGET_APOAPSIS
    ? Number(process.env.JUNO_TARGET_APOAPSIS)
    : null;
  const targetPeriapsis = process.env.JUNO_TARGET_PERIAPSIS
    ? Number(process.env.JUNO_TARGET_PERIAPSIS)
    : 70000;

  const trace = [];
  // The climb is flown with no attitude input whatsoever: overriding an axis
  // disables the game's stability assist, and left alone the vehicle holds a
  // dead-straight vertical climb. All the turning happens in the coast, where
  // there is no thrust and no hurry.
  // A calibration flight: hold one axis at a fixed command from the given time
  // and record how the nose swings, which settles the polarity of that input.
  const probe =
    process.env.JUNO_PROBE === undefined
      ? null
      : {
          after: Number(process.env.JUNO_PROBE_AFTER ?? 8),
          input: JSON.parse(process.env.JUNO_PROBE),
        };

  const climb = await ascend({
    durationS,
    trace,
    started,
    probe,
    polarity: {
      pitch: Number(process.env.JUNO_PITCH_SIGN ?? 1),
      yaw: Number(process.env.JUNO_YAW_SIGN ?? 1),
    },
    gravityTurn: false,
    kickTiltDeg: Number(process.env.JUNO_KICK_TILT ?? 10),
    turnStart: Number(process.env.JUNO_TURN_START ?? 8000),
    engageDeg: Number(process.env.JUNO_ENGAGE ?? 12),
    releaseDeg: Number(process.env.JUNO_RELEASE ?? 3),
    twrCap: Number(process.env.JUNO_TWR_CAP ?? 2.2),
    targetApoapsis,
  });

  // Reaching the target apoapsis is only half an orbit: without a burn at the
  // high point the periapsis stays underground and the craft comes back down.
  if (targetApoapsis !== null)
    await circularise({
      trace,
      targetPeriapsis,
      durationS,
      startedAt: started,
      nose: climb.nose,
      polarity: {
        pitch: Number(process.env.JUNO_PITCH_SIGN ?? 1),
        yaw: Number(process.env.JUNO_YAW_SIGN ?? 1),
      },
    });

  await post('/flight/input', { mode: 'clear' }).catch(() => {});
  console.log(summarise(trace));

  // Stamped per run: comparing a good flight against a bad one is the only way
  // to find what varies between them, and a fixed name destroys the evidence
  // from every run but the last.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const traceFile = `/tmp/juno-flight-${craftId.replace(/\W+/g, '_')}-${stamp}.json`;
  await (await import('node:fs/promises')).writeFile(traceFile, JSON.stringify(trace, null, 2));
  console.error(`full trace → ${traceFile}`);
}

main().catch((e) => {
  console.error(`failed: ${e.message}`);
  process.exit(1);
});
