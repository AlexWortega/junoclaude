// Резолв путей установки Juno: New Origins.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';

const HOME = homedir();

const DEFAULTS = {
  install: join(HOME, 'Library/Application Support/Steam/steamapps/common/SimpleRockets2'),
  user: join(HOME, 'Library/Application Support/com.jundroo.SimpleRockets2'),
  log: join(HOME, 'Library/Logs/Jundroo/SimpleRockets 2/Player.log'),
};

export interface GamePaths {
  installDir: string;
  userDir: string;
  logPath: string;
  app: string;
  modToolsPackage: string;
  craftDesigns: string;
  flightPrograms: string;
  subassemblies: string;
  gameStates: string;
  stockFlightStates: string;
  mods: string;
  settings: string;
  backups: string;
  gameVersion?: string;
  unityVersion?: string;
  installed: boolean;
  userDataPresent: boolean;
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false
  );

async function readVersions(installDir: string): Promise<{
  gameVersion?: string;
  unityVersion?: string;
}> {
  try {
    const text = await readFile(join(installDir, 'SimpleRockets2.app/Contents/Info.plist'), 'utf8');
    return {
      gameVersion: /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
        text
      )?.[1],
      unityVersion: /Unity Player version ([0-9a-zA-Z.]+)/.exec(text)?.[1],
    };
  } catch {
    return {};
  }
}

let cached: GamePaths | undefined;

/**
 * Пути игры. Переопределяются через JUNO_INSTALL_DIR / JUNO_USER_DIR /
 * JUNO_LOG_PATH — нужно и для тестов, и для нестандартных установок Steam.
 */
export async function gamePaths(refresh = false): Promise<GamePaths> {
  if (cached && !refresh) return cached;

  const installDir = process.env.JUNO_INSTALL_DIR ?? DEFAULTS.install;
  const userDir = process.env.JUNO_USER_DIR ?? DEFAULTS.user;
  const logPath = process.env.JUNO_LOG_PATH ?? DEFAULTS.log;
  const { gameVersion, unityVersion } = await readVersions(installDir);

  cached = {
    installDir,
    userDir,
    logPath,
    gameVersion,
    unityVersion,
    app: join(installDir, 'SimpleRockets2.app'),
    modToolsPackage: join(installDir, 'ModTools/SimpleRockets2_ModTools.unitypackage'),
    craftDesigns: join(userDir, 'UserData/CraftDesigns'),
    flightPrograms: join(userDir, 'UserData/FlightPrograms'),
    subassemblies: join(userDir, 'UserData/Subassemblies'),
    gameStates: join(userDir, 'UserData/GameStates'),
    stockFlightStates: join(userDir, 'GameData/FlightStates'),
    mods: join(userDir, 'Mods'),
    settings: join(userDir, 'Settings.xml'),
    backups: join(userDir, '.junoclaude-backups'),
    installed: await exists(installDir),
    userDataPresent: await exists(userDir),
  };
  return cached;
}

/**
 * Проверяет имя, приходящее от модели и превращающееся в имя файла.
 * Крафты живут в плоском каталоге, поэтому разделители пути, `..` и ведущая
 * точка — всегда ошибка, а не экзотическое имя.
 */
export function assertSafeName(name: string, what = 'имя'): string {
  if (name.length === 0) throw new Error(`${what} не может быть пустым`);
  if (name.includes('/') || name.includes('\\'))
    throw new Error(`${what} не может содержать разделители пути: ${JSON.stringify(name)}`);
  if (name === '.' || name === '..' || name.startsWith('.'))
    throw new Error(`${what} не может начинаться с точки: ${JSON.stringify(name)}`);
  if (/[\0<>:"|?*]/.test(name))
    throw new Error(`${what} содержит недопустимые символы: ${JSON.stringify(name)}`);
  return name;
}
