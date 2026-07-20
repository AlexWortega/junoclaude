#!/usr/bin/env node
// Works out the trans-lunar injection from live bridge data.
//
// A Hohmann transfer needs three numbers the client cannot invent: where Luna
// is, how big its orbit is, and how fast it goes round. All three now come from
// /planets, which reports each body's planet-centred position and full orbital
// elements — the same frame the craft's own `position.pci` uses, so the phase
// angle between craft and moon is just the angle between two vectors.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JUNO_BRIDGE ?? 'http://127.0.0.1:7842';
const TOKEN_FILE = join(
  homedir(),
  'Library/Application Support/com.jundroo.SimpleRockets2/junobridge.token'
);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const unit = (v) => v.map((x) => x / len(v));
const deg = (r) => (r * 180) / Math.PI;

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (json.ok !== true) throw new Error(`${path}: ${JSON.stringify(json.error)}`);
  return json.data;
}

const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
const [planets, telemetry] = await Promise.all([
  get('/planets', token),
  get('/telemetry', token),
]);

const byName = new Map(planets.planets.map((p) => [p.name, p]));
const target = byName.get(process.argv[2] ?? 'Luna');
if (target === undefined) {
  console.error(`no such body; known: ${[...byName.keys()].join(', ')}`);
  process.exit(1);
}
if (target.position === undefined) {
  console.error(
    'This body carries no position. The mod that reports it is installed but the\n' +
      'game has to be restarted before it takes effect — replacing a mod in place\n' +
      'is not picked up by a running game.'
  );
  process.exit(1);
}

const parent = byName.get(target.parent);
const craft = telemetry.position.pci;
const craftR = len(craft);

// The gravitational parameter of the parent, measured rather than assumed:
// surface gravity times radius squared. Droo came out at 1.593e13 from
// g = 9.81 and R = 1274.2 km, which is the number every burn here is sized on.
const parentRadius = parent?.radius ?? 1274196;
const mu = 9.81 * parentRadius * parentRadius;

const r1 = craftR;
const r2 = len(target.position);
const a = (r1 + r2) / 2;

const transferTime = Math.PI * Math.sqrt((a * a * a) / mu);
const targetPeriod = target.orbit?.period ?? 2 * Math.PI * Math.sqrt((r2 * r2 * r2) / mu);
const targetRate = (2 * Math.PI) / targetPeriod; // rad/s

// Where the moon has to be *now* for it to arrive when the craft does.
const leadAngle = Math.PI - targetRate * transferTime;

// Current angle from craft to target, signed by the craft's orbital direction so
// "ahead" and "behind" mean the same thing they do in flight.
const craftVel = telemetry.velocity.orbital;
const normal = unit(cross(craft, craftVel));
const cosine = dot(unit(craft), unit(target.position));
const sine = dot(normal, cross(unit(craft), unit(target.position)));
let phase = Math.atan2(sine, cosine);
if (phase < 0) phase += 2 * Math.PI;

const dv = Math.sqrt(mu / r1) * (Math.sqrt((2 * r2) / (r1 + r2)) - 1);

// How long until the geometry comes round, given the moon moves and the craft
// moves faster.
const craftPeriod = telemetry.orbit?.period ?? 2 * Math.PI * Math.sqrt((r1 * r1 * r1) / mu);
const relativeRate = (2 * Math.PI) / craftPeriod - targetRate;
let wait = (phase - leadAngle) / relativeRate;
const synodic = (2 * Math.PI) / Math.abs(relativeRate);
while (wait < 0) wait += synodic;

const km = (x) => (x / 1000).toFixed(1);
console.log(`target            ${target.name} (around ${target.parent})`);
console.log(`  radius          ${km(target.radius ?? 0)} km`);
console.log(`  sphere of infl. ${km(target.sphereOfInfluence)} km`);
console.log(`  orbital radius  ${km(r2)} km`);
console.log(`  period          ${(targetPeriod / 3600).toFixed(2)} h`);
console.log(`craft`);
console.log(`  orbital radius  ${km(r1)} km  (altitude ${km(r1 - parentRadius)} km)`);
console.log(`  period          ${(craftPeriod / 3600).toFixed(2)} h`);
console.log(`transfer`);
console.log(`  delta-v         ${dv.toFixed(1)} m/s`);
console.log(`  coast time      ${(transferTime / 3600).toFixed(2)} h`);
console.log(`  lead angle      ${deg(leadAngle).toFixed(1)}° (moon ahead of craft at burn)`);
console.log(`  phase now       ${deg(phase).toFixed(1)}°`);
console.log(`  wait            ${(wait / 60).toFixed(1)} min  (synodic ${(synodic / 3600).toFixed(2)} h)`);
