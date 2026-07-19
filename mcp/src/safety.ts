// The write safety layer.
//
// The plugin writes into a directory holding hundreds of hours of someone
// else's work. Three defences: a snapshot before every write, a refusal to
// write while the game is running, and an atomic file swap. None of them may
// be optional by default.

import { mkdir, writeFile, readFile, rename, rm, readdir, stat, cp } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { gamePaths } from './paths.js';

const execAsync = promisify(exec);

/** An error a tool returns to the model as a value rather than throwing. */
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** PID of the running game, if it is up. */
export async function gamePid(): Promise<number | undefined> {
  try {
    const { stdout } = await execAsync('pgrep -f "SimpleRockets2.app/Contents/MacOS"');
    const pid = Number(stdout.trim().split('\n')[0]);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    // pgrep exits with code 1 when there are no matches — that is not an error.
    return undefined;
  }
}

/** The directories writing is permitted into at all. */
async function writableRoots(): Promise<string[]> {
  const p = await gamePaths();
  return [
    join(p.userDir, 'UserData'),
    join(p.userDir, 'GameData'),
    p.mods,
    p.settings,
    p.backups,
  ].map((x) => resolve(x));
}

/** The path must lie inside a permitted root. */
export async function assertWritablePath(target: string): Promise<void> {
  const abs = resolve(target);
  const roots = await writableRoots();
  const ok = roots.some((root) => abs === root || abs.startsWith(root + sep));
  if (!ok)
    throw new ToolError(
      'path_not_allowed',
      `Writing outside the game directory is not allowed: ${abs}`,
      { allowedRoots: roots }
    );
}

export interface WriteGuardOptions {
  /** Explicit consent to write while the game runs. The skill forbids it unasked. */
  force?: boolean;
}

/**
 * Files the game rewrites itself. Editing them live either gets lost or
 * clobbers the user's state.
 *
 * The craft design and flight program directories are deliberately left out:
 * it has been verified in practice that the game does not cache their listing —
 * a craft written while the game is running shows up in the designer right away
 * and opens fine. Blocking such a write would mean demanding a game restart for
 * no reason at all.
 */
const LIVE_STATE_PATTERNS = [/\/GameStates\//, /Settings\.xml$/, /\/Career\//];

export async function assertSafeToWrite(
  target: string,
  opts: WriteGuardOptions = {}
): Promise<void> {
  await assertWritablePath(target);
  if (opts.force === true) return;

  const pid = await gamePid();
  if (pid !== undefined && LIVE_STATE_PATTERNS.some((re) => re.test(target)))
    throw new ToolError(
      'game_running',
      `Juno is running (pid ${pid}) and ${target} is rewritten by the game itself — the edit will be lost ` +
        `or will clobber the current state.`,
      { pid, fix: 'Call game_quit or ask the user to exit the game.' }
    );

  // A very recent edit means someone is writing the file right now.
  try {
    const st = await stat(target);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < 3000)
      throw new ToolError(
        'file_busy',
        `${target} was modified ${Math.round(ageMs)} ms ago — another write may be in progress.`,
        { ageMs }
      );
  } catch (e) {
    if (e instanceof ToolError) throw e;
    // The file does not exist — we are creating a new one, which is fine.
  }
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');

export interface SnapshotEntry {
  path: string;
  created: boolean;
}

export interface SnapshotManifest {
  id: string;
  tool: string;
  timestamp: string;
  files: SnapshotEntry[];
}

/**
 * Stores copies of files before modifying them. Inside a snapshot the original's
 * relative path is reproduced, so restoring is a plain copy.
 */
export async function snapshot(tool: string, targets: string[]): Promise<SnapshotManifest> {
  const p = await gamePaths();
  const id = `${stamp()}_${tool}`;
  const dir = join(p.backups, id);
  const files: SnapshotEntry[] = [];

  for (const target of targets) {
    const rel = relative(p.userDir, resolve(target));
    const dest = join(dir, rel);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await cp(target, dest, { recursive: true });
      files.push({ path: target, created: false });
    } catch {
      // The file does not exist yet: mark it so a rollback deletes it rather
      // than "restoring" it.
      files.push({ path: target, created: true });
    }
  }

  const manifest: SnapshotManifest = { id, tool, timestamp: new Date().toISOString(), files };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await pruneSnapshots();
  return manifest;
}

const MAX_SNAPSHOTS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function pruneSnapshots(): Promise<void> {
  const p = await gamePaths();
  let entries: string[];
  try {
    entries = await readdir(p.backups);
  } catch {
    return;
  }
  const sorted = entries.filter((e) => e !== '.DS_Store').sort();
  const cutoff = Date.now() - MAX_AGE_MS;

  const doomed = new Set<string>();
  if (sorted.length > MAX_SNAPSHOTS)
    for (const e of sorted.slice(0, sorted.length - MAX_SNAPSHOTS)) doomed.add(e);
  for (const e of sorted) {
    try {
      const st = await stat(join(p.backups, e));
      if (st.mtimeMs < cutoff) doomed.add(e);
    } catch {
      /* already gone */
    }
  }
  for (const e of doomed) await rm(join(p.backups, e), { recursive: true, force: true });
}

export async function listSnapshots(): Promise<SnapshotManifest[]> {
  const p = await gamePaths();
  let entries: string[];
  try {
    entries = await readdir(p.backups);
  } catch {
    return [];
  }
  const out: SnapshotManifest[] = [];
  for (const e of entries.sort().reverse()) {
    try {
      out.push(JSON.parse(await readFile(join(p.backups, e, 'manifest.json'), 'utf8')));
    } catch {
      /* a directory without a manifest is ignored */
    }
  }
  return out;
}

/** Puts the files from a snapshot back; the ones created from scratch are deleted. */
export async function restoreSnapshot(id: string): Promise<SnapshotManifest> {
  const p = await gamePaths();
  const dir = join(p.backups, id);
  const manifest: SnapshotManifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8')
  );

  for (const entry of manifest.files) {
    await assertSafeToWrite(entry.path);
    if (entry.created) {
      await rm(entry.path, { recursive: true, force: true });
    } else {
      const src = join(dir, relative(p.userDir, resolve(entry.path)));
      await mkdir(dirname(entry.path), { recursive: true });
      await cp(src, entry.path, { recursive: true });
    }
  }
  return manifest;
}

/**
 * Atomic write: a temporary file next to the target, then a rename. The game
 * will never see half-written XML, even if the process dies midway.
 */
export async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.junoclaude.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}

/** Snapshot + write — the normal path for any mutating tool. */
export async function guardedWrite(
  tool: string,
  target: string,
  content: string,
  opts: WriteGuardOptions = {}
): Promise<SnapshotManifest> {
  await assertSafeToWrite(target, opts);
  const manifest = await snapshot(tool, [target]);
  await writeAtomic(target, content);
  return manifest;
}
