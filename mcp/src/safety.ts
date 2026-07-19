// Слой безопасности записи.
//
// Плагин пишет в каталог, где лежат сотни часов чужой работы. Три защиты:
// снапшот перед каждой записью, отказ писать при запущенной игре и атомарная
// подмена файла. Ни одна из них не должна быть необязательной по умолчанию.

import { mkdir, writeFile, readFile, rename, rm, readdir, stat, cp } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { gamePaths } from './paths.js';

const execAsync = promisify(exec);

/** Ошибка, которую тул отдаёт моделью как значение, а не как исключение. */
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

/** PID запущенной игры, если она работает. */
export async function gamePid(): Promise<number | undefined> {
  try {
    const { stdout } = await execAsync('pgrep -f "SimpleRockets2.app/Contents/MacOS"');
    const pid = Number(stdout.trim().split('\n')[0]);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    // pgrep выходит с кодом 1, когда совпадений нет — это не ошибка.
    return undefined;
  }
}

/** Директории, в которые вообще разрешено писать. */
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

/** Путь должен лежать внутри разрешённого корня. */
export async function assertWritablePath(target: string): Promise<void> {
  const abs = resolve(target);
  const roots = await writableRoots();
  const ok = roots.some((root) => abs === root || abs.startsWith(root + sep));
  if (!ok)
    throw new ToolError(
      'path_not_allowed',
      `Запись за пределы каталога игры запрещена: ${abs}`,
      { allowedRoots: roots }
    );
}

export interface WriteGuardOptions {
  /** Явное согласие писать при запущенной игре. Скилл запрещает без спроса. */
  force?: boolean;
}

/**
 * Отказывает в записи, если игра запущена. Игра читает UserData при старте и
 * переписывает при сохранении, поэтому запись «на живую» либо потеряется,
 * либо затрёт работу пользователя.
 */
export async function assertSafeToWrite(
  target: string,
  opts: WriteGuardOptions = {}
): Promise<void> {
  await assertWritablePath(target);
  if (opts.force === true) return;

  const pid = await gamePid();
  if (pid !== undefined)
    throw new ToolError(
      'game_running',
      `Juno запущена (pid ${pid}). Запись в ${target} будет потеряна при сохранении из игры ` +
        `или затрёт текущее состояние.`,
      { pid, fix: 'Вызовите game_quit или попросите пользователя выйти из игры.' }
    );

  // Свежая правка означает, что файл прямо сейчас кто-то пишет.
  try {
    const st = await stat(target);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < 3000)
      throw new ToolError(
        'file_busy',
        `${target} изменён ${Math.round(ageMs)} мс назад — возможно, идёт другая запись.`,
        { ageMs }
      );
  } catch (e) {
    if (e instanceof ToolError) throw e;
    // Файла нет — создаём новый, это нормально.
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
 * Сохраняет копии файлов перед изменением. Внутри снапшота повторяется
 * относительный путь оригинала, поэтому восстановление — обычное копирование.
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
      // Файла ещё нет: помечаем, чтобы откат его удалил, а не «восстановил».
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
      /* уже исчез */
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
      /* каталог без манифеста игнорируем */
    }
  }
  return out;
}

/** Возвращает файлы из снапшота на место; созданные с нуля — удаляет. */
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
 * Атомарная запись: временный файл рядом с целевым, затем rename. Игра никогда
 * не увидит наполовину записанный XML, даже если процесс умрёт посередине.
 */
export async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.junoclaude.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}

/** Снапшот + запись — обычный путь для любого изменяющего тула. */
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
