// Resolving the paths of a Juno: New Origins installation.
// The catalog build scripts and the MCP server must see the same paths, so the
// logic lives here rather than being duplicated.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';

const HOME = homedir();

const DEFAULT_INSTALL = join(
  HOME,
  'Library/Application Support/Steam/steamapps/common/SimpleRockets2'
);
const DEFAULT_USER = join(HOME, 'Library/Application Support/com.jundroo.SimpleRockets2');
const DEFAULT_LOG = join(HOME, 'Library/Logs/Jundroo/SimpleRockets 2/Player.log');

const exists = (p) =>
  access(p).then(
    () => true,
    () => false
  );

/** Pulls the game and Unity versions out of Info.plist inside the .app. */
async function readVersions(installDir) {
  const plist = join(installDir, 'SimpleRockets2.app/Contents/Info.plist');
  try {
    const text = await readFile(plist, 'utf8');
    const short = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    const unity = /Unity Player version ([0-9a-zA-Z.]+)/.exec(text);
    return { gameVersion: short?.[1], unityVersion: unity?.[1] };
  } catch {
    return {};
  }
}

/**
 * @returns the game's paths. Overridable via JUNO_INSTALL_DIR / JUNO_USER_DIR /
 * JUNO_LOG_PATH — needed both for tests and for non-standard Steam installs.
 */
export async function gamePaths() {
  const installDir = process.env.JUNO_INSTALL_DIR || DEFAULT_INSTALL;
  const userDir = process.env.JUNO_USER_DIR || DEFAULT_USER;
  const logPath = process.env.JUNO_LOG_PATH || DEFAULT_LOG;

  const { gameVersion, unityVersion } = await readVersions(installDir);

  return {
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
}
