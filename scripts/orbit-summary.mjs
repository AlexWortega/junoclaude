#!/usr/bin/env node
// Reports the best orbit from one or more flight traces.
//
// Traces are stamped per run so good and bad flights can be compared; this
// prints the one line that decides whether a run counts as a success, plus the
// initial conditions worth comparing across runs.

import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = '/tmp';

async function traces(pattern) {
  const all = await readdir(DIR);
  return all
    .filter((f) => f.startsWith('juno-flight-') && f.endsWith('.json') && f.includes(pattern))
    .sort()
    .map((f) => join(DIR, f));
}

const pattern = process.argv[2] ?? '';
const files = await traces(pattern);
if (files.length === 0) {
  console.error(`no traces matching "${pattern}"`);
  process.exit(1);
}

const ORBIT_MIN = 70000;
let passes = 0;

for (const file of files) {
  const trace = JSON.parse(await readFile(file, 'utf8'));
  const pts = trace.filter((p) => p.periapsis !== null && p.periapsis !== undefined);
  if (pts.length === 0) {
    console.log(`${file.split('/').pop()}  no orbit data`);
    continue;
  }
  const best = pts.reduce((a, b) => (b.periapsis > a.periapsis ? b : a));
  const notes = trace.filter((p) => p.note !== undefined);
  const calib = notes.find((n) => n.note.startsWith('pitch calibration'));
  const still = notes.find((n) => n.note.startsWith('calibration done'));
  const warns = notes.filter((n) => n.note.startsWith('WARNING')).length;
  const ok = best.periapsis >= ORBIT_MIN;
  if (ok) passes += 1;

  console.log(
    `${ok ? 'PASS' : 'fail'}  pe ${(best.periapsis / 1000).toFixed(1).padStart(8)} km  ` +
      `ap ${(best.apoapsis / 1000).toFixed(1).padStart(7)} km  ecc ${best.eccentricity.toFixed(3)}  ` +
      `warns ${String(warns).padStart(3)}  ${file.split('/').pop()}`
  );
  if (calib !== undefined) console.log(`        ${calib.note}`);
  if (still !== undefined) console.log(`        ${still.note}`);
}

console.log(`\n${passes}/${files.length} runs reached periapsis above ${ORBIT_MIN / 1000} km`);
