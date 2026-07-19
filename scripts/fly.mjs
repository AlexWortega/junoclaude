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

/** Telemetry flattened to the handful of numbers the loop actually steers on. */
function digest(t) {
  return {
    altitude: t.position.altitudeAsl,
    agl: t.position.altitudeAgl,
    vertical: t.velocity.vertical,
    surfaceSpeed: t.velocity.surfaceMagnitude,
    pitch: t.attitude.pitch,
    bank: t.attitude.bank,
    forward: t.attitude.forward,
    thrust: t.propulsion.currentThrust,
    twr: t.propulsion.twr,
    fuel: t.mass.fuel,
    stage: t.state.currentStage,
    numStages: t.state.numStages,
    parts: t.state.partCount,
    grounded: t.state.grounded,
    apoapsis: t.orbit?.valid ? t.orbit.apoapsis : null,
    periapsis: t.orbit?.valid ? t.orbit.periapsis : null,
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
async function ascend({ durationS = 120, sampleMs = 500, targetApoapsis = null }) {
  const trace = [];
  const started = Date.now();
  let lastStageAt = 0;
  let stallSince = null;

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

    trace.push({ t: Number(((Date.now() - started) / 1000).toFixed(1)), ...t });

    // Stage when the current one is dry, with a cooldown so a single dry
    // reading cannot burn through every stage at once.
    const elapsed = (Date.now() - started) / 1000;
    if (t.fuel <= 0.01 && t.stage < t.numStages && elapsed - lastStageAt > 2) {
      await post('/flight/stage', {});
      lastStageAt = elapsed;
    }

    if (targetApoapsis !== null && t.apoapsis !== null && t.apoapsis >= targetApoapsis) {
      await post('/flight/input', { mode: 'hold', throttle: 0 });
      trace.push({ t: elapsed, note: 'target apoapsis reached' });
      break;
    }

    // Not climbing while under thrust means the vehicle is lying over or stuck:
    // burning the rest of the fuel into the ground teaches us nothing.
    if (!t.grounded && t.thrust > 0 && t.vertical < 1) {
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

  await post('/flight/input', { mode: 'clear' }).catch(() => {});
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
  if (last.apoapsis !== null && last.apoapsis !== undefined)
    lines.push(`orbit   apoapsis ${(last.apoapsis / 1000).toFixed(1)}km periapsis ${(last.periapsis / 1000).toFixed(1)}km`);
  for (const n of notes) lines.push(`note    t+${n.t}: ${n.note ?? n.error}`);
  return lines.join('\n');
}

async function main() {
  const [craftId, location = 'DSC Large Pad', durationRaw = '90'] = process.argv.slice(2);
  if (craftId === undefined) {
    console.error('usage: fly.mjs <craftId> [launchLocation] [durationSeconds]');
    process.exit(1);
  }

  token = (await readFile(TOKEN_FILE, 'utf8')).trim();

  const status = await get('/status');
  console.error(`bridge ok, scene=${status.scene}`);

  await post('/flight/launch', { craftId, launchLocation: location });
  await waitForFlight();
  await sleep(3000);

  const before = digest(await get('/telemetry'));
  console.error(
    `on pad: alt ${before.altitude.toFixed(1)}m agl ${before.agl.toFixed(1)}m ` +
      `pitch ${before.pitch.toFixed(1)}° parts ${before.parts} fuel ${before.fuel.toFixed(0)}`
  );

  const trace = await ascend({ durationS: Number(durationRaw) });
  console.log(summarise(trace));

  const traceFile = `/tmp/juno-flight-${craftId.replace(/\W+/g, '_')}.json`;
  await (await import('node:fs/promises')).writeFile(traceFile, JSON.stringify(trace, null, 2));
  console.error(`full trace → ${traceFile}`);
}

main().catch((e) => {
  console.error(`failed: ${e.message}`);
  process.exit(1);
});
