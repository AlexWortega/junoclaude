#!/usr/bin/env node
// Extracts files from a .unitypackage (gzip-tar) by pathname.
//
// The format: each asset lives in a directory named after its GUID:
//   <guid>/asset       — the contents
//   <guid>/asset.meta  — the metadata
//   <guid>/pathname    — the path inside Assets/, which is the point of it all
//
// We look up by pathname, not by GUID: the GUID changes between game versions,
// the pathname does not. Two passes, because tar is a stream and `pathname`
// may come after `asset` within the same directory.

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;

/** A minimal streaming tar reader — enough for the .unitypackage format. */
async function* readTar(stream) {
  let buf = Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  buf = Buffer.concat(chunks);

  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    // Two consecutive zero blocks mean the end of the archive.
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    off += BLOCK;
    // '0' and '\0' mean a regular file; directories ('5') and the rest are skipped.
    if (typeFlag === '0' || typeFlag === '\0') {
      yield { name, data: buf.subarray(off, off + size) };
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
}

/**
 * @param {string} pkgPath path to the .unitypackage
 * @param {Set<string>} wanted the pathnames wanted, e.g. 'Assets/ModTools/Parts/Parts.xml'
 * @returns {Promise<Map<string, Buffer>>} pathname → contents
 */
export async function extractByPathname(pkgPath, wanted) {
  const guidToPath = new Map();
  const assets = new Map(); // guid → Buffer

  // A single pass: collect both pathnames and asset blobs, decide at the end.
  // Holding every asset in memory costs more, but the .unitypackage here is
  // 11 MB — cheaper than a second pass with gzip decompression.
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
      `Not found in ${pkgPath}:\n  ${missing.join('\n  ')}\n` +
        `The game may have updated and the path changed. ${guidToPath.size} assets available.`
    );
  }
  return out;
}

// CLI: node extract-unitypackage.mjs <pkg> <pathname> [output file]
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
    console.error(`${data.length} bytes → ${outFile}`);
  } else {
    process.stdout.write(data);
  }
}
