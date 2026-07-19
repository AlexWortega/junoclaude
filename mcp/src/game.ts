// Managing the game process and reading its log.
//
// Until the bridge mod is installed, Player.log is the only feedback channel
// out of the game, which is why its parsing gets more attention than you might
// expect.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { gamePaths } from './paths.js';
import { gamePid } from './safety.js';
import { parseXmlRoot, childNamed } from './xml.js';

const execAsync = promisify(exec);

export interface GameStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  gameVersion?: string;
  unityVersion?: string;
  appVersionLastRun?: string;
  activeGameStateId?: string;
  optimizeCraftXML?: boolean;
  modSupportEnabled?: boolean;
  skipMainMenu?: boolean;
  installedMods: string[];
  craftCount?: number;
  logLastWrite?: string;
  warnings: string[];
}

export async function gameStatus(): Promise<GameStatus> {
  const p = await gamePaths(true);
  const pid = await gamePid();
  const warnings: string[] = [];

  const status: GameStatus = {
    installed: p.installed,
    running: pid !== undefined,
    pid,
    gameVersion: p.gameVersion,
    unityVersion: p.unityVersion,
    installedMods: [],
    warnings,
  };

  if (!p.installed) {
    warnings.push(
      `Game not found in ${p.installDir}. Set JUNO_INSTALL_DIR if it is installed elsewhere.`
    );
    return status;
  }

  try {
    const root = parseXmlRoot(await readFile(p.settings, 'utf8'), 'Settings');
    status.activeGameStateId = root.attrs['gameStateId'];
    status.appVersionLastRun = root.attrs['appVersionLastRun'];

    const designer = childNamed(root, 'Designer');
    // By default the game minifies craft XML, dropping default values. To
    // compare a generated craft against what the game saved this has to be
    // turned off — otherwise the diffs are unreadable.
    status.optimizeCraftXML = designer?.attrs['optimizeCraftXML'] !== 'false';

    const general = childNamed(root, 'General');
    status.skipMainMenu = general?.attrs['skipMainMenu'] === 'true';

    const mods = childNamed(root, 'Mods');
    status.modSupportEnabled = mods?.attrs['modSupportEnabled'] === 'true';
  } catch (e) {
    warnings.push(`Could not read Settings.xml: ${(e as Error).message}`);
  }

  try {
    const { readdir } = await import('node:fs/promises');
    status.craftCount = (await readdir(p.craftDesigns)).filter(
      (f) => f.endsWith('.xml') && !f.startsWith('__')
    ).length;
  } catch {
    /* the directory may not exist on a fresh install */
  }

  try {
    const { readdir } = await import('node:fs/promises');
    status.installedMods = (await readdir(p.mods)).filter((f) => f.endsWith('.sr2-mod'));
  } catch {
    /* the mods directory is created by the game */
  }

  try {
    status.logLastWrite = (await stat(p.logPath)).mtime.toISOString();
  } catch {
    warnings.push('Player.log not found — the game has never been launched.');
  }

  if (
    status.appVersionLastRun !== undefined &&
    p.gameVersion !== undefined &&
    !status.appVersionLastRun.startsWith(p.gameVersion)
  )
    warnings.push(
      `The catalog was built for version ${p.gameVersion}, but the last run was ` +
        `${status.appVersionLastRun}. The formats may have changed — rebuild the catalog.`
    );

  return status;
}

export async function launchGame(): Promise<{ pid?: number; alreadyRunning: boolean }> {
  const existing = await gamePid();
  if (existing !== undefined) return { pid: existing, alreadyRunning: true };

  const p = await gamePaths();
  await execAsync(`open -a ${JSON.stringify(p.app)}`);

  // `open` returns before the process has come up.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const pid = await gamePid();
    if (pid !== undefined) return { pid, alreadyRunning: false };
  }
  return { alreadyRunning: false };
}

export async function quitGame(force = false): Promise<{ wasRunning: boolean }> {
  const pid = await gamePid();
  if (pid === undefined) return { wasRunning: false };

  if (force) {
    await execAsync(`kill -9 ${pid}`);
    return { wasRunning: true };
  }

  // Quitting politely lets the game save its state; killing the process would
  // lose an unsaved flight.
  await execAsync(`osascript -e 'tell application "SimpleRockets2" to quit'`).catch(async () => {
    await execAsync(`kill ${pid}`);
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await gamePid()) === undefined) return { wasRunning: true };
  }
  throw new Error(`The game did not quit within 20 s (pid ${pid}). Use force: true.`);
}

const ERROR_PATTERN =
  /(Exception|NullReference|Error:|ERROR|Failed to|Could not|Invalid|error CS\d+)/i;
/** How many lines after an error line to treat as its stack. */
const STACK_LINES = 12;

export interface LogResult {
  path: string;
  totalLines: number;
  returned: string;
  truncated: boolean;
}

export async function readLog(
  opts: { lines?: number; filter?: 'all' | 'errors' | 'mods' } = {}
): Promise<LogResult> {
  const { lines = 200, filter = 'errors' } = opts;
  const p = await gamePaths();
  const text = await readFile(p.logPath, 'utf8');
  const all = text.split('\n');

  if (filter === 'all') {
    const slice = all.slice(-lines);
    return {
      path: p.logPath,
      totalLines: all.length,
      returned: slice.join('\n'),
      truncated: all.length > lines,
    };
  }

  if (filter === 'mods') {
    const relevant = all.filter((l) => /mod/i.test(l));
    return {
      path: p.logPath,
      totalLines: all.length,
      returned:
        relevant.length > 0 ? relevant.slice(-lines).join('\n') : '(no mentions of mods in the log)',
      truncated: relevant.length > lines,
    };
  }

  // Errors without a stack are useless, and repeated ones flood the output:
  // collect each with the lines that follow and collapse identical ones.
  const blocks: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    const line = all[i] as string;
    if (!ERROR_PATTERN.test(line)) continue;

    const block: string[] = [line];
    for (let j = i + 1; j < Math.min(i + 1 + STACK_LINES, all.length); j++) {
      const next = all[j] as string;
      // The stack ended once the text stopped looking like a trace frame.
      if (next.trim() === '') break;
      if (ERROR_PATTERN.test(next)) break;
      block.push(next);
      if (!/^\s|^\s*at |^UnityEngine|^\s*[A-Za-z.]+\(/.test(next)) break;
    }
    i += block.length - 1;

    const signature = line.trim().slice(0, 160);
    const count = seen.get(signature) ?? 0;
    seen.set(signature, count + 1);
    if (count === 0) blocks.push(block.join('\n'));
  }

  const repeated = [...seen.entries()].filter(([, n]) => n > 1);
  const parts: string[] = [];
  if (blocks.length === 0) parts.push('(no errors found in the log)');
  else parts.push(blocks.slice(-lines).join('\n\n'));
  if (repeated.length > 0)
    parts.push(
      '',
      'Repeated errors:',
      ...repeated.map(([sig, n]) => `  ${n}× ${sig}`)
    );

  return {
    path: p.logPath,
    totalLines: all.length,
    returned: parts.join('\n'),
    truncated: blocks.length > lines,
  };
}
