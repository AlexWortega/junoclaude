#!/usr/bin/env node
// Синхронизирует исходники мода в Unity-проект.
//
// Править C# удобнее в репозитории, но Unity компилирует только то, что лежит
// в его Assets/. Копирование вручную после каждой правки — верный способ
// однажды собрать мод из устаревших исходников и долго искать несуществующую
// ошибку, поэтому пусть этим занимается скрипт.

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Editor/ обязателен для воспроизводимой сборки с нуля: без JunoBridgeBuild.cs
// нечего звать через -executeMethod, а без .asmdef рядом с ним корневой
// JunoBridge.asmdef (его ModTools генерирует сам при каждой сборке) затягивает
// редакторный скрипт в рантайм-сборку мода, и сборка скриптов игрока падает.
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
    console.error('usage: sync-mod-sources.mjs <путь-к-Unity-проекту>');
    console.error('пример: node scripts/sync-mod-sources.mjs ~/UnityProjects/JunoBridgeMod');
    process.exit(1);
  }

  try {
    const st = await stat(join(project, 'Assets'));
    if (!st.isDirectory()) throw new Error('не каталог');
  } catch {
    console.error(
      `В ${project} нет каталога Assets/ — это не похоже на проект Unity.\n` +
        `Создайте проект в Unity Hub редактором 2022.3.62f3 и укажите путь к нему.`
    );
    process.exit(1);
  }

  for (const [from, to] of DIRS) {
    const source = join(ROOT, from);
    const dest = join(project, to);
    // Удаляем перед копированием: иначе переименованный или удалённый в
    // репозитории файл останется в проекте и будет ломать компиляцию дублем.
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(source, dest, { recursive: true });
    console.error(`${await countFiles(source)} файлов → ${dest}`);
  }

  console.error('Переключитесь в Unity — он подхватит изменения и пересоберёт.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
