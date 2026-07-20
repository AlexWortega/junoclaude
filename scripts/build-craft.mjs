#!/usr/bin/env node
// Builds a craft from a JSON spec file through the MCP server.
//
// craft_build is an MCP tool, so reaching it means a handshake and three
// framed messages. Doing that by hand with printf per iteration is slow and
// easy to get wrong; a build is one command here.
//
// usage: build-craft.mjs <spec.json> [--dry-run]

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const [specFile, ...flags] = process.argv.slice(2);
if (specFile === undefined) {
  console.error('usage: build-craft.mjs <spec.json> [--dry-run]');
  process.exit(1);
}

const spec = JSON.parse(await readFile(specFile, 'utf8'));
const dryRun = flags.includes('--dry-run');

const messages = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'build-craft', version: '1' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'craft_build', arguments: { force: true, dry_run: dryRun, spec } },
  },
];

const child = spawn('node', [`${root}/mcp/dist/index.js`], {
  env: { ...process.env, JUNO_PLUGIN_ROOT: root },
  stdio: ['pipe', 'pipe', 'inherit'],
});

child.stdin.end(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (const line of buffer.split('\n').slice(0, -1)) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== 2) continue;
    if (msg.error !== undefined) {
      console.error(`craft_build failed: ${msg.error.message}`);
      process.exit(1);
    }
    for (const part of msg.result?.content ?? []) console.log(part.text);
    process.exit(msg.result?.isError === true ? 1 : 0);
  }
  buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
});
