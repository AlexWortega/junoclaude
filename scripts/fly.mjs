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
 * Tilt signed by whether the nose leans along the direction of travel or
 * against it: +90 is horizontal and prograde, -90 horizontal and retrograde.
 *
 * The unsigned angle is direction-blind, and that is a hole big enough to lose
 * an orbit through. A craft pointing backwards along the horizon reads exactly
 * 90 and the loop reports no error at all, while the burn subtracts horizontal
 * speed instead of adding it — one flight watched it fall from 1507 to 555 m/s
 * with the tilt sitting on target the whole way. Signing it makes that a 180°
 * error, which the loop then rotates out through the vertical.
 */
function signedTilt(t, nose) {
  const tilt = tiltFromVertical(t, nose);
  const z = zenithOf(t);
  const flat = (v) => add(v, scale(z, -dot(v, z)));
  const noseFlat = flat(scale(unit(t.att[nose.axis]), nose.sign));
  const velFlat = flat(t.velocityVector ?? [0, 0, 0]);
  // Near the vertical the nose has almost no horizontal part and the sign is
  // noise; the error is then about 90° whichever way it is read, so leave it.
  if (vecLength(noseFlat) < 1e-3 || vecLength(velFlat) < 20) return tilt;
  return dot(unit(noseFlat), unit(velFlat)) >= 0 ? tilt : -tilt;
}

/**
 * Steer the nose towards a direction tilted `tiltDeg` from the vertical, in the
 * given compass azimuth.
 *
 * The rotation that takes the nose onto the target is about `nose × target`,
 * whose magnitude is the sine of the angle still to close. Projecting that axis
 * onto the two body axes perpendicular to the nose gives the two rate commands
 * directly, so nothing has to be guessed from the frame's handedness — only the
 * polarity of each input axis, which the calibration below measures.
 */
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
  sampleMs = 250,
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
  let frozenFor = 0;
  let dryFor = 0;
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
    dryFor = t.thrust < 1 || t.stageFuel <= 0.01 ? dryFor + 1 : 0;
    if (dryFor >= 3 && t.stage < t.numStages - 1 && elapsed > 3 && elapsed - lastStageAt > 6) {
      await post('/flight/stage', {});
      lastStageAt = elapsed;
      dryFor = 0;
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
      frozenFor += 1;
      if (frozenFor > 12) {
        trace.push({ t: elapsed, note: 'aborted: telemetry frozen, craft is gone' });
        break;
      }
    } else {
      frozenFor = 0;
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
  sampleMs = 250,
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
  let dryFor = 0;
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
  let calibration = { state: 'pulse', at: null, tilt0: null, cmd: 0.06, prevTilt: null, prevAt: null };
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
    const tilt = signedTilt(t, nose);
    sample.tilt = Number(tilt.toFixed(1));
    const reach = cross(unit(t.att.right), scale(unit(t.att[nose.axis]), nose.sign));
    const z = zenithOf(t);
    const horizontal = (() => {
      const h = add(reach, scale(z, -dot(reach, z)));
      if (vecLength(h) < 1e-6) return unit(t.att.east);
      const v = t.velocityVector ?? [0, 0, 0];
      const vh = add(v, scale(z, -dot(v, z)));
      return vecLength(vh) > 20 && dot(unit(h), vh) < 0 ? scale(unit(h), -1) : unit(h);
    })();

    // Calibrate the pitch polarity before doing anything else with the axis.
    // The plant is dω/dt = P·cmd; for the loop to be stable its polarity has to
    // equal sign(P), so a known command is held briefly and the resulting change
    // in rotation rate about `right` is measured.
    if (calibration.state !== 'done') {
      const omega = rateAboutRight(t);
      if (calibration.state === 'pulse') {
        if (calibration.at === null) {
          calibration.at = elapsed;
          calibration.tilt0 = tilt;
        } else if (elapsed - calibration.at >= 2.5) {
          const delta = tilt - calibration.tilt0;
          sign = delta > 0 ? 1 : -1;
          calibration.state = 'null';
          trace.push({
            t: elapsed,
            note:
              `pitch calibration: cmd +${calibration.cmd} moved tilt by ` +
              `${delta.toFixed(1)}°, so +cmd ${sign > 0 ? 'raises' : 'lowers'} tilt`,
          });
        }
        await post('/flight/input', { mode: 'hold', throttle: 0, pitch: calibration.cmd });
        await sleep(sampleMs);
        continue;
      }
      // Stop the rotation the pulse started before handing over to the loop,
      // measured in the same scalar everything else here uses.
      //
      // Nulling `ω · right` instead does not work: pitch does not necessarily
      // act about the craft's `right` axis, so that projection can be small
      // while the craft is still swinging. A run left the calibration at
      // -0.0135 rad/s on the timeout having never reached the threshold, and
      // carried the leftover spin into the slew.
      const nullRate = calibration.prevTilt === null ? 0 : (tilt - calibration.prevTilt) / (elapsed - calibration.prevAt);
      calibration.prevTilt = tilt;
      calibration.prevAt = elapsed;

      if (Math.abs(nullRate) < 0.4) stillFor += 1;
      else stillFor = 0;
      if (stillFor >= 4 || elapsed - calibration.at > 40) {
        calibration.state = 'done';
        await post('/flight/input', { mode: 'hold', throttle: 0, pitch: null });
        holdingPitch = false;
        trace.push({
          t: elapsed,
          note: `calibration done, residual tilt rate ${nullRate.toFixed(2)} deg/s`,
        });
      } else {
        // 0.01 per deg/s was too weak to stop the pulse inside the timeout: one
        // run left calibration at 1.06 deg/s having never reached 0.4.
        const c = Math.max(-0.05, Math.min(0.05, sign * -nullRate * 0.04));
        await post('/flight/input', { mode: 'hold', throttle: 0, pitch: c });
      }
      await sleep(sampleMs);
      continue;
    }

    // Start the burn a little before the high point so it straddles apoapsis.
    if (!burning && t.timeToApoapsis !== null && t.timeToApoapsis < 25) {
      burning = true;
      burnStartedAt = elapsed;
      trace.push({ t: elapsed, note: `circularisation burn at ${(t.altitude / 1000).toFixed(0)}km` });
    }

    // Two different regimes, and they need different handling.
    //
    // Coasting, the only actuator is the command pod's own torque: the loop
    // converges cleanly, taking the tilt 8° to 89° with the command tapering
    // 0.025 -> 0.002 -> -0.009 on the way in. So hold it there continuously.
    // Releasing at 90° hands the nose to the stability assist, which holds
    // attitude *inertially* — and over a hundred seconds of coast the local
    // vertical rotates out from under it, drifting the tilt to 126° by the time
    // the burn starts. That drift alone pointed the first burn backwards and
    // dropped the horizontal speed from 195 to 129 m/s.
    //
    // Burning, the engine gimbal is the actuator and it is far stronger. The
    // same gains that converge on pod torque tumbled the craft, swinging the
    // tilt 173° -> 7° -> 170°. So the burn uses a fraction of the gain and
    // leans on the assist through a deadband.
    // Damping has to be strong and the position term gentle. With both at one
    // gain the loop tracked well until stage two ran light, then lost it: the
    // tilt rate went 2 -> 8 -> 22 -> -39 deg/s in five seconds while the command
    // was still only -0.05. A rate error now commands most of the available
    // authority, so a developing tumble is arrested, while the angle error alone
    // never asks for more than a couple of degrees a second.
    const activeGain = burning ? 0.01 : 0.012;
    const rateLimit = burning ? 2.5 : 4;
    // Hold the burn attitude tightly. A wide deadband lets the error grow to
    // 10° before the loop reacts, and at full thrust that misdirects a large
    // amount of impulse: attempts drifted 14-38° off and their periapsis ended
    // hundreds of kilometres apart from the same configuration.
    const activeEngage = burning ? 4 : 1;
    const activeRelease = burning ? 1.5 : 0.4;

    const error = Math.abs(tilt - 90);

    // Sanity check: under a non-zero command the error must shrink. If it grows
    // instead, say so in the trace. Silently steering the wrong way is the worst
    // failure mode this loop has had, and it cost several flights before it was
    // spotted — an alarm makes it obvious in the summary.
    if (steering && prevError !== null && error > prevError + 0.05) {
      if (++growingFor === 3)
        trace.push({
          t: elapsed,
          note: `WARNING: error growing under command (${prevError.toFixed(1)}° -> ${error.toFixed(1)}°), polarity ${sign} may be wrong`,
        });
    } else if (steering) growingFor = 0;
    prevError = steering ? error : null;

    if (steering && error < activeRelease) steering = false;
    else if (!steering && error > activeEngage) steering = true;

    // Burn at part throttle. The vehicle carries roughly three times the Δv it
    // needs, so trading burn efficiency for control is cheap — at full thrust a
    // given attitude error misdirects the maximum possible impulse, and the
    // 4 Hz loop gets the fewest samples per unit of Δv exactly when it matters.
    const throttle = burning ? burnThrottle : 0;
    // Cascade in tilt: the angle error asks for a turn rate, and the command
    // closes on that rate using the rate actually measured between samples.
    const dt = prevAt === null ? 0 : elapsed - prevAt;
    const tiltRate = dt > 0.05 ? (tilt - prevTilt) / dt : 0;
    prevTilt = tilt;
    prevAt = elapsed;

    if (steering) {
      const wantedRate = Math.max(-rateLimit, Math.min(rateLimit, (90 - tilt) * 0.25)); // deg/s
      const raw = sign * activeGain * (wantedRate - tiltRate);
      const cmd = Math.max(-0.12, Math.min(0.12, raw));
      sample.cmdPitch = Number(cmd.toFixed(4));
      sample.tiltRate = Number(tiltRate.toFixed(2));
      holdingPitch = true;
      await post('/flight/input', { mode: 'hold', throttle, pitch: cmd });
    } else {
      // Hand the nose back to the game's stability assist, which holds it far
      // better than this loop can at four samples a second.
      await post('/flight/input', {
        mode: 'hold',
        throttle,
        ...(holdingPitch ? { pitch: null } : {}),
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
    dryFor = burning && settled && (t.thrust < 1 || t.stageFuel <= 0.01) ? dryFor + 1 : 0;
    if (dryFor >= 3 && t.stage < t.numStages - 1 && elapsed - lastStageAt > 6) {
      await post('/flight/stage', {});
      lastStageAt = elapsed;
      dryFor = 0;
      burnStartedAt = elapsed;
      trace.push({ t: elapsed, note: `staged to ${t.stage + 1}/${t.numStages}` });
    }

    await sleep(sampleMs);
  }
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
