#!/usr/bin/env node
// Does the craft rotate when told to?
//
// Every attitude conclusion in this project was drawn from craft whose
// gyroscope carried `maxAcceleration="0"` and therefore produced no torque at
// all. This asks the one question those flights could never answer, in the
// simplest way available: hold one control axis and watch the angular velocity.

import { readFile } from 'node:fs/promises';
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
  if (json.ok !== true && json.error) throw new Error(json.error.code);
  return json.data;
};
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b ?? {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const len = (v) => Math.hypot(v[0], v[1], v[2]);

const craftId = process.argv[2] ?? 'JC-Orbit-03';
token = (await readFile(TOKEN_FILE, 'utf8')).trim();

let status = await get('/status');
for (let i = 0; i < 40 && status.transitioning; i++) {
  await sleep(2000);
  status = await get('/status');
}
// The launch call can time out on the game's main thread while a scene is
// still tearing down; that is a transient, not a failure.
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
await sleep(3000);

// Get clear of the pad first: a clamped craft cannot turn no matter what.
await post('/flight/input', { mode: 'hold', throttle: 1 });
await post('/flight/stage', {});
for (let i = 0; i < 60; i++) {
  const t = await get('/telemetry');
  if (t.position.altitudeAgl > 400) break;
  await sleep(500);
}

const rows = [];
for (const axis of ['pitch', 'yaw', 'roll']) {
  // Let whatever is spinning die down, then hold one axis and watch.
  await post('/flight/input', { mode: 'hold', throttle: 1, pitch: 0, yaw: 0, roll: 0 });
  await sleep(2000);
  const before = len((await get('/telemetry')).velocity.angular);
  await post('/flight/input', { mode: 'hold', throttle: 1, [axis]: 0.5 });
  await sleep(2500);
  const after = len((await get('/telemetry')).velocity.angular);
  rows.push({ axis, before, after, gained: after - before });
  console.log(
    `${axis.padEnd(6)} |omega| ${before.toFixed(4)} -> ${after.toFixed(4)} rad/s  ` +
      `(${(((after - before) * 180) / Math.PI).toFixed(1)} deg/s gained)`
  );
}

await post('/flight/input', { mode: 'clear' }).catch(() => {});
const responsive = rows.filter((r) => r.gained > 0.01).length;
console.log(
  responsive === 0
    ? 'VERDICT: the craft does not respond to any control axis.'
    : `VERDICT: ${responsive} of 3 axes produce rotation — the craft can be steered.`
);
