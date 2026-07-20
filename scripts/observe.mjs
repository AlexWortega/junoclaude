#!/usr/bin/env node
// Launches a craft and records telemetry without steering it.
//
// For flights where the craft flies itself — a Vizzy program aboard doing the
// throttle, the staging and the attitude — the outside job is only to watch and
// to save the evidence. Nothing here posts a control input, so whatever the
// trace shows is the game's own behaviour rather than a mixture of the two.

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JUNO_BRIDGE ?? 'http://127.0.0.1:7842';
const TOKEN_FILE = join(
  homedir(),
  'Library/Application Support/com.jundroo.SimpleRockets2/junobridge.token'
);

let token = '';
const api = async (method, path, body) => {
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
  if (json.ok !== true && json.error) {
    const e = new Error(json.error.code);
    e.code = json.error.code;
    throw e;
  }
  return json.data;
};
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b ?? {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const unit = (v) => v.map((x) => x / len(v));

const [craftId = 'JC-Orbit-03', durationRaw = '600'] = process.argv.slice(2);
const durationS = Number(durationRaw);
token = (await readFile(TOKEN_FILE, 'utf8')).trim();

let status = await get('/status');
for (let i = 0; i < 40 && status.transitioning; i++) {
  await sleep(2000);
  status = await get('/status');
}
for (let i = 0; i < 5; i++) {
  try {
    await post('/flight/launch', { craftId, launchLocation: 'DSC Large Pad' });
    break;
  } catch (e) {
    if (i === 4) throw e;
    await sleep(4000);
  }
}
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const s = await get('/status');
  if (s.scene === 'flight' && s.hasCraft && !s.transitioning) break;
}

const trace = [];
const started = Date.now();
let radius = null;
let frozenSince = null;
let prev = null;
let warpMode = 1;

while ((Date.now() - started) / 1000 < durationS) {
  let t;
  try {
    t = await get('/telemetry');
  } catch (e) {
    trace.push({ t: (Date.now() - started) / 1000, error: e.code });
    if (e.code === 'no_craft' || e.code === 'wrong_scene') break;
    await sleep(500);
    continue;
  }
  const elapsed = (Date.now() - started) / 1000;
  if (radius === null) radius = len(t.position.pci) - t.position.altitudeAsl;

  const orbit = t.orbit?.valid === true ? t.orbit : null;
  // How closely the nose follows the velocity vector: this is the whole
  // question when the game is the one holding attitude.
  const nose = unit(t.attitude.up);
  const vel = t.velocity.orbital;
  const progradeError =
    len(vel) > 10 ? (Math.acos(Math.max(-1, Math.min(1, dot(nose, unit(vel))))) * 180) / Math.PI : null;

  const row = {
    t: Number(elapsed.toFixed(1)),
    altitude: t.position.altitudeAsl,
    agl: t.position.altitudeAgl,
    vertical: t.velocity.vertical,
    surfaceSpeed: t.velocity.surfaceMagnitude,
    orbitalSpeed: t.velocity.orbitalMagnitude,
    thrust: t.propulsion.currentThrust,
    twr: t.propulsion.twr,
    fuel: t.mass.fuel,
    battery: t.mass.remainingBattery,
    stage: t.state.currentStage,
    numStages: t.state.numStages,
    parts: t.state.partCount,
    grounded: t.state.grounded,
    progradeError,
    angular: t.velocity.angular,
    apoapsis: orbit === null ? null : orbit.apoapsisDistance - radius,
    periapsis: orbit === null ? null : orbit.periapsisDistance - radius,
    eccentricity: orbit === null ? null : orbit.eccentricity,
    period: orbit === null ? null : orbit.period,
    trueAnomaly: orbit === null ? null : orbit.trueAnomaly,
  };
  trace.push(row);

  // A destroyed craft freezes its telemetry rather than erroring.
  if (prev !== null && row.altitude === prev.altitude && row.surfaceSpeed === prev.surfaceSpeed) {
    frozenSince ??= elapsed;
    if (elapsed - frozenSince > 4) {
      trace.push({ t: elapsed, note: 'telemetry frozen, craft is gone' });
      break;
    }
  } else frozenSince = null;
  prev = row;

  // Warp through the ballistic coast, and only there.
  //
  // The requested modeIndex comes back one lower than asked for, so the values
  // here are what the bridge actually reports: 4 is 10x, 6 is 100x. High warp
  // is refused outright while the craft is on an impact course, which is a
  // useful signal in itself — a vehicle that cannot warp is not in an orbit.
  //
  // Only on unpowered coast, and back to normal well before the burn: the
  // program aboard waits in half-second steps, and at 10x those become five
  // seconds, which is enough to overshoot a burn start.
  const coasting = row.thrust < 1 && row.altitude > 60000 && !row.grounded;
  const nearBurn = row.apoapsis !== null && t.orbit?.timeToApoapsis < 120;
  const wantWarp = coasting && !nearBurn ? 5 : 1;
  if (wantWarp !== warpMode) {
    try {
      const r = await post('/flight/timewarp', { modeIndex: wantWarp });
      warpMode = wantWarp;
      trace.push({ t: elapsed, note: `timewarp ${r.modeName}` });
    } catch {
      warpMode = 1; // refused, usually an impact course; try again later
    }
  }

  await sleep(200);
}
await post('/flight/timewarp', { modeIndex: 1 }).catch(() => {});

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = `/tmp/juno-obs-${craftId.replace(/\W+/g, '_')}-${stamp}.json`;
await writeFile(file, JSON.stringify(trace, null, 2));

const pts = trace.filter((x) => x.altitude !== undefined);
const peak = pts.reduce((a, b) => (b.altitude > a.altitude ? b : a), pts[0]);
const withOrbit = pts.filter((x) => x.periapsis !== null);
const best = withOrbit.length
  ? withOrbit.reduce((a, b) => (b.periapsis > a.periapsis ? b : a))
  : null;
const tracked = pts.filter((x) => x.progradeError !== null && x.thrust > 1);

console.log(`samples ${pts.length}, duration ${pts[pts.length - 1]?.t}s`);
console.log(`peak altitude ${(peak.altitude / 1000).toFixed(1)} km`);
if (tracked.length)
  console.log(
    `prograde error while thrusting: median ${tracked
      .map((x) => x.progradeError)
      .sort((a, b) => a - b)[Math.floor(tracked.length / 2)]
      .toFixed(1)}°, final ${tracked[tracked.length - 1].progradeError.toFixed(1)}°`
  );
if (best)
  console.log(
    `best orbit: periapsis ${(best.periapsis / 1000).toFixed(1)} km, ` +
      `apoapsis ${(best.apoapsis / 1000).toFixed(1)} km, ecc ${best.eccentricity.toFixed(3)}`
  );
console.log(`trace → ${file}`);
