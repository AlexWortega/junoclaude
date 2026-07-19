#!/usr/bin/env node
// Syncs the mod sources into the Unity project.
//
// Editing C# is more convenient in the repository, but Unity compiles only what
// lives in its Assets/. Copying by hand after every edit is a reliable way to
// eventually build the mod from stale sources and spend a long time hunting a
// bug that does not exist, so let a script do it.

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Editor/ is required for a reproducible build from scratch: without
// JunoBridgeBuild.cs there is nothing to call via -executeMethod, and without
// an .asmdef next to it the root JunoBridge.asmdef (which ModTools generates
// itself on every build) pulls the editor script into the mod's runtime
// assembly, and the player script build fails.
const DIRS = [
  ['mod/Scripts/JunoBridge', 'Assets/JunoBridge'],
  ['mod/Editor', 'Assets/Editor'],
];

async function countFiles(dir) {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) n++;
  return n;
}

async function main() {
  const project = process.argv[2];
  if (project === undefined) {
    console.error('usage: sync-mod-sources.mjs <path-to-Unity-project>');
    console.error('example: node scripts/sync-mod-sources.mjs ~/UnityProjects/JunoBridgeMod');
    process.exit(1);
  }

  try {
    const st = await stat(join(project, 'Assets'));
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(
      `${project} has no Assets/ directory — this does not look like a Unity project.\n` +
        `Create a project in Unity Hub with editor 2022.3.62f3 and point at it.`
    );
    process.exit(1);
  }

  for (const [from, to] of DIRS) {
    const source = join(ROOT, from);
    const dest = join(project, to);
    // Delete before copying: otherwise a file renamed or removed in the
    // repository stays in the project and breaks compilation as a duplicate.
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(source, dest, { recursive: true });
    console.error(`${await countFiles(source)} files → ${dest}`);
  }

  console.error('Switch to Unity — it will pick up the changes and rebuild.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
