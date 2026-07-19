#!/usr/bin/env node
// Извлекает файлы из .unitypackage (gzip-tar) по pathname.
//
// Формат: каждый ассет лежит в каталоге, названном его GUID:
//   <guid>/asset       — содержимое
//   <guid>/asset.meta  — метаданные
//   <guid>/pathname    — путь внутри Assets/, ради которого всё и затевается
//
// Ищем по pathname, а не по GUID: GUID меняется между версиями игры,
// pathname — нет. Два прохода, потому что tar — поток, и `pathname`
// может идти после `asset` внутри одного каталога.

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;

/** Минимальный потоковый ридер tar — достаточно для формата .unitypackage. */
async function* readTar(stream) {
  let buf = Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  buf = Buffer.concat(chunks);

  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    // Два нулевых блока подряд — конец архива.
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    off += BLOCK;
    // '0' и '\0' — обычный файл; каталоги ('5') и прочее пропускаем.
    if (typeFlag === '0' || typeFlag === '\0') {
      yield { name, data: buf.subarray(off, off + size) };
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
}

/**
 * @param {string} pkgPath путь к .unitypackage
 * @param {Set<string>} wanted нужные pathname, например 'Assets/ModTools/Parts/Parts.xml'
 * @returns {Promise<Map<string, Buffer>>} pathname → содержимое
 */
export async function extractByPathname(pkgPath, wanted) {
  const guidToPath = new Map();
  const assets = new Map(); // guid → Buffer

  // Один проход: собираем и pathname, и asset-блобы, решаем в конце.
  // Держать все asset'ы в памяти дороже, но .unitypackage здесь 11 МБ —
  // это дешевле второго прохода с распаковкой gzip.
  for await (const entry of readTar(createReadStream(pkgPath).pipe(createGunzip()))) {
    const slash = entry.name.indexOf('/');
    if (slash < 0) continue;
    const guid = entry.name.slice(0, slash);
    const file = entry.name.slice(slash + 1);

    if (file === 'pathname') {
      guidToPath.set(guid, entry.data.toString('utf8').split('\n')[0].trim());
    } else if (file === 'asset') {
      assets.set(guid, entry.data);
    }
  }

  const out = new Map();
  for (const [guid, path] of guidToPath) {
    if (wanted.has(path) && assets.has(guid)) out.set(path, assets.get(guid));
  }

  const missing = [...wanted].filter((w) => !out.has(w));
  if (missing.length) {
    throw new Error(
      `Не найдено в ${pkgPath}:\n  ${missing.join('\n  ')}\n` +
        `Возможно, обновилась игра и путь изменился. Доступно ${guidToPath.size} ассетов.`
    );
  }
  return out;
}

// CLI: node extract-unitypackage.mjs <pkg> <pathname> [выходной файл]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [pkg, pathname, outFile] = process.argv.slice(2);
  if (!pkg || !pathname) {
    console.error('usage: extract-unitypackage.mjs <package> <pathname> [out]');
    process.exit(1);
  }
  const got = await extractByPathname(pkg, new Set([pathname]));
  const data = got.get(pathname);
  if (outFile) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outFile, data);
    console.error(`${data.length} байт → ${outFile}`);
  } else {
    process.stdout.write(data);
  }
}
