#!/usr/bin/env node
// JunoClaude MCP server: tools for reading, generating and running
// Juno: New Origins content.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { gamePaths, assertSafeName } from './paths.js';
import { ToolError, guardedWrite, listSnapshots, restoreSnapshot } from './safety.js';
import { gameStatus, launchGame, quitGame, readLog } from './game.js';
import { parts as partsCatalog, partType, connections } from './catalog.js';
import { Craft } from './craft/model.js';
import { buildCraft, type CraftSpec } from './craft/build.js';
import { summarize, renderSummary, renderTree } from './craft/summary.js';
import { buildXml, parseXmlRoot, GAME_FORMAT } from './xml.js';
import { compileProgram, CompileError, type DslProgram } from './vizzy/compile.js';
import { decompileProgram } from './vizzy/decompile.js';

const server = new McpServer({ name: 'juno', version: '0.1.0' });

/** A tool reply is always text; errors are returned as values, not thrown. */
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const fail = (e: unknown) => {
  if (e instanceof ToolError)
    return text(
      `Error (${e.code}): ${e.message}` +
        (Object.keys(e.details).length > 0
          ? `\n${JSON.stringify(e.details, null, 2)}`
          : '')
    );
  if (e instanceof CompileError)
    return text(`Compile error at ${e.path}: ${e.message}` + (e.hint ? `\n${e.hint}` : ''));
  return text(`Error: ${(e as Error).message}`);
};

/** Wraps a handler so a thrown error does not take down the connection. */
const guard =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };

const craftPath = async (name: string): Promise<string> =>
  join((await gamePaths()).craftDesigns, `${assertSafeName(name, 'Craft name')}.xml`);

// --- Game state ---

server.registerTool(
  'game_state',
  {
    title: 'Game state',
    description:
      'Checks the Juno: New Origins installation, whether the game is running, the active save and key settings. ' +
      'Call this before any write: writing while the game is running is not allowed.',
    inputSchema: {},
  },
  guard(async () => {
    const s = await gameStatus();
    const lines = [
      s.installed ? `Game installed, version ${s.gameVersion} (Unity ${s.unityVersion})` : 'Game NOT found',
      s.running ? `Running (pid ${s.pid}) — writing is blocked` : 'Not running — writing is allowed',
    ];
    if (s.craftCount !== undefined) lines.push(`Crafts in the save: ${s.craftCount}`);
    if (s.activeGameStateId !== undefined) lines.push(`Active save: ${s.activeGameStateId}`);
    if (s.optimizeCraftXML !== undefined)
      lines.push(
        `optimizeCraftXML: ${s.optimizeCraftXML} ${s.optimizeCraftXML ? '(the game minifies crafts; turn this off to compare diffs)' : ''}`
      );
    if (s.modSupportEnabled !== undefined) lines.push(`Mod support: ${s.modSupportEnabled}`);
    lines.push(
      s.installedMods.length > 0
        ? `Installed mods: ${s.installedMods.join(', ')}`
        : 'No mods installed — the bridge is unavailable, working through files'
    );
    if (s.logLastWrite !== undefined) lines.push(`Player.log last written: ${s.logLastWrite}`);
    if (s.warnings.length > 0) lines.push('', 'Warnings:', ...s.warnings.map((w) => `  ! ${w}`));
    return text(lines.join('\n'));
  })
);

// --- Crafts ---

server.registerTool(
  'craft_list',
  {
    title: 'List crafts',
    description: 'Lists saved designs with their size and part count.',
    inputSchema: { pattern: z.string().optional().describe('Substring to filter names by') },
  },
  guard(async ({ pattern }: { pattern?: string }) => {
    const p = await gamePaths();
    const files = (await readdir(p.craftDesigns)).filter(
      (f) => f.endsWith('.xml') && !f.startsWith('__partIcons__')
    );
    const rows: string[] = [];
    for (const f of files.sort()) {
      const name = f.replace(/\.xml$/, '');
      if (pattern !== undefined && !name.toLowerCase().includes(pattern.toLowerCase())) continue;
      const full = join(p.craftDesigns, f);
      const st = await stat(full);
      // Count parts the cheap way: fully parsing a 2 MB file for a single
      // number is not worth it.
      const partCount = (await readFile(full, 'utf8')).split('<Part ').length - 1;
      rows.push(
        `  ${name.padEnd(40)} ${String(partCount).padStart(4)} parts  ${(st.size / 1024).toFixed(0).padStart(5)} KB`
      );
    }
    return text(rows.length > 0 ? `Crafts (${rows.length}):\n${rows.join('\n')}` : 'No crafts found');
  })
);

const MAX_XML_PARTS = 50;
const MAX_XML_BYTES = 200_000;

server.registerTool(
  'craft_read',
  {
    title: 'Read a craft',
    description:
      'Reads a design. By default returns a summary: stages, engines, fuel, flight programs. ' +
      'Mode tree shows the part tree, xml returns raw XML for the listed parts only ' +
      '(crafts reach 2 MB, so the full XML is never returned).',
    inputSchema: {
      name: z.string().describe('Craft name without .xml'),
      mode: z.enum(['summary', 'tree', 'xml']).default('summary'),
      part_ids: z.array(z.number()).optional().describe('Required for mode=xml'),
      max_depth: z.number().optional().describe('Tree depth for mode=tree'),
    },
  },
  guard(
    async ({
      name,
      mode = 'summary',
      part_ids,
      max_depth,
    }: {
      name: string;
      mode?: 'summary' | 'tree' | 'xml';
      part_ids?: number[];
      max_depth?: number;
    }) => {
      const path = await craftPath(name);
      const raw = await readFile(path, 'utf8');
      const craft = Craft.parse(raw);

      if (mode === 'summary') return text(renderSummary(await summarize(craft, raw.length)));
      if (mode === 'tree') return text(renderTree(craft, max_depth ?? 99));

      if (part_ids === undefined || part_ids.length === 0)
        throw new ToolError(
          'part_ids_required',
          'mode=xml requires part_ids. Find the parts you need via mode=tree or mode=summary.',
          { partCount: craft.parts.length }
        );
      if (part_ids.length > MAX_XML_PARTS)
        throw new ToolError(
          'too_many_parts',
          `Requested ${part_ids.length} parts, the maximum is ${MAX_XML_PARTS}.`,
          {}
        );

      const chunks: string[] = [];
      const missing: number[] = [];
      for (const id of part_ids) {
        const part = craft.part(id);
        if (part === undefined) {
          missing.push(id);
          continue;
        }
        chunks.push(buildXml(part.node, { ...GAME_FORMAT, declaration: false, bom: false }));
      }
      for (const c of craft.connections)
        if (part_ids.includes(c.partA) && part_ids.includes(c.partB))
          chunks.push(buildXml(c.node, { ...GAME_FORMAT, declaration: false, bom: false }));

      let out = chunks.join('\n');
      if (out.length > MAX_XML_BYTES) out = `${out.slice(0, MAX_XML_BYTES)}\n… truncated`;
      if (missing.length > 0) out = `(parts not present in the craft: ${missing.join(', ')})\n${out}`;
      return text(out);
    }
  )
);

server.registerTool(
  'craft_build',
  {
    title: 'Build a design',
    description:
      'Builds a vehicle from a declarative spec: a stack of parts from the bottom up. ' +
      'It works out the coordinates itself, picks attach points from mined recipes, ' +
      'computes tank capacity and splits parts into physical bodies at the decouplers. ' +
      'Item kinds: pod, tank, engine, decoupler, nosecone, parachute, raw.',
    inputSchema: {
      spec: z
        .object({
          name: z.string(),
          type: z.enum(['rocket', 'plane']).optional(),
          stack: z.array(z.any()).describe('Bottom-up: item 0 sits on the launch pad'),
          activation_groups: z.array(z.string()).optional(),
        })
        .describe(
          'Example: { "name":"Probe", "stack":[ {"kind":"engine","nozzle":"Bravo","stage":0}, ' +
            '{"kind":"tank","length":5,"diameter":2}, {"kind":"pod"}, {"kind":"parachute","stage":1} ] }'
        ),
      dry_run: z.boolean().optional().describe('Only show the result, without writing'),
      force: z.boolean().optional(),
    },
  },
  guard(
    async ({
      spec,
      dry_run,
      force,
    }: {
      spec: CraftSpec;
      dry_run?: boolean;
      force?: boolean;
    }) => {
      const result = await buildCraft(spec);
      const lines = [
        `Built: "${spec.name}", ${result.partCount} parts`,
        '',
        'Layout (bottom-up, Y coordinate of the centre):',
        ...result.layout.map(
          (l) =>
            `  ${String(l.id).padStart(2)}  ${l.partType.padEnd(16)} y=${String(l.y).padStart(8)}  h=${l.height}${l.stage > 0 ? `  stage ${l.stage}` : ''}`
        ),
      ];
      if (result.warnings.length > 0)
        lines.push('', 'Warnings:', ...result.warnings.map((w) => `  ! ${w.message}`));

      if (dry_run === true) {
        lines.push('', '--- XML ---', result.xml.replace(/\r/g, ''));
        return text(lines.join('\n'));
      }

      const path = await craftPath(spec.name);
      const snap = await guardedWrite('craft_build', path, result.xml, { force });
      lines.push('', `Written: ${path}`, `Snapshot to roll back to: ${snap.id}`);
      return text(lines.join('\n'));
    }
  )
);

// --- Part reference ---

server.registerTool(
  'part_lookup',
  {
    title: 'Part reference',
    description:
      'Searches part types and shows their attach points, modifiers and the connection recipes ' +
      'mined from existing crafts. Call this before editing a <Connection> by hand.',
    inputSchema: {
      query: z.string().optional().describe('Substring of the name or id'),
      id: z.string().optional().describe('Exact partType, for example Fuselage1'),
      category: z.string().optional(),
    },
  },
  guard(
    async ({ query, id, category }: { query?: string; id?: string; category?: string }) => {
      const cat = await partsCatalog();

      if (id !== undefined) {
        const pt = await partType(id);
        if (pt === undefined) {
          const near = Object.keys(cat.parts)
            .filter((k) => k.toLowerCase().includes(id.toLowerCase().slice(0, 5)))
            .slice(0, 5);
          throw new ToolError('unknown_part_type', `Part type "${id}" not found.`, {
            suggestions: near,
          });
        }
        const lines = [
          `${pt.id} — ${pt.name}${pt.procedural ? ' (procedural: geometry comes from a modifier)' : ''}`,
          pt.categories.length > 0 ? `Categories: ${pt.categories.join(', ')}` : '',
          '',
          'Attach points (indices for attachPointsA/B):',
          ...pt.attachPoints.map(
            (a) =>
              `  ${a.index}  ${a.kind.padEnd(8)} ${a.name}${a.tag !== undefined ? ` tag=${a.tag}` : ''}` +
              `${a.position !== undefined ? ` pos=${a.position.join(',')}` : ''}`
          ),
          '',
          `Modifiers: ${Object.keys(pt.modifiers).join(', ')}`,
        ];

        const conn = (await connections()).connections[pt.id];
        if (conn !== undefined) {
          lines.push('', 'Known connection recipes (mined from existing crafts):');
          for (const [other, entry] of Object.entries(conn).slice(0, 14)) {
            const bits: string[] = [];
            if (entry.stack) bits.push(`stack a="${entry.stack.a}" b="${entry.stack.b}" (${entry.stack.seen}×)`);
            if (entry.surface)
              bits.push(`surface a="${entry.surface.a}" b="${entry.surface.b}" (${entry.surface.seen}×)`);
            if (bits.length > 0) lines.push(`  → ${other}: ${bits.join('; ')}`);
          }
        }
        if (pt.designerParts.length > 0)
          lines.push(
            '',
            `Designer presets: ${pt.designerParts.map((d) => d.name).slice(0, 12).join(', ')}`
          );
        return text(lines.filter((l) => l !== '').join('\n'));
      }

      const q = (query ?? '').toLowerCase();
      const matches = Object.values(cat.parts).filter((pt) => {
        if (category !== undefined && !pt.categories.includes(category)) return false;
        if (q === '') return true;
        return (
          pt.id.toLowerCase().includes(q) ||
          pt.name.toLowerCase().includes(q) ||
          pt.designerParts.some((d) => d.name.toLowerCase().includes(q))
        );
      });
      if (matches.length === 0) return text(`Nothing found for "${query ?? category}"`);
      return text(
        `Found ${matches.length}:\n` +
          matches
            .map((pt) => `  ${pt.id.padEnd(22)} ${pt.name}${pt.procedural ? ' [procedural]' : ''}`)
            .join('\n')
      );
    }
  )
);

// --- Vizzy ---

async function craftPropertySet(): Promise<Set<string>> {
  const root = process.env.JUNO_PLUGIN_ROOT ?? join(import.meta.dirname, '..', '..');
  const blocks = JSON.parse(
    await readFile(join(root, 'catalog', 'vizzy-blocks.json'), 'utf8')
  ) as { craftProperties: Record<string, string> };
  return new Set(Object.keys(blocks.craftProperties));
}

server.registerTool(
  'vizzy_read',
  {
    title: 'Read a flight program',
    description:
      'Reads a Vizzy program — either from a standalone file or embedded in a craft part — ' +
      'and returns it in a compact DSL instead of verbose XML.',
    inputSchema: {
      file: z.string().optional().describe('File name in UserData/FlightPrograms without .xml'),
      craft: z.string().optional().describe('Name of the craft with the embedded program'),
      part_id: z.number().optional().describe('The craft part carrying the program'),
    },
  },
  guard(
    async ({ file, craft, part_id }: { file?: string; craft?: string; part_id?: number }) => {
      const p = await gamePaths();
      if (file !== undefined) {
        const path = join(p.flightPrograms, `${assertSafeName(file, 'Program name')}.xml`);
        const program = parseXmlRoot(await readFile(path, 'utf8'), 'Program');
        return text(JSON.stringify(decompileProgram(program), null, 2));
      }
      if (craft === undefined)
        throw new ToolError('missing_source', 'Specify either file, or craft + part_id.', {});

      const parsed = Craft.parse(await readFile(await craftPath(craft), 'utf8'));
      const candidates = parsed.parts.filter((x) => x.modifiers.includes('FlightProgram'));
      const target =
        part_id !== undefined ? parsed.part(part_id) : candidates[0];
      if (target === undefined)
        throw new ToolError('no_program', 'The craft has no part with a flight program.', {
          candidates: candidates.map((c) => c.id),
        });

      const program = target.node.children
        .find((c) => c.tag === 'FlightProgram')
        ?.children.find((c) => c.tag === 'Program');
      if (program === undefined)
        throw new ToolError('empty_program', `Part ${target.id} has a computer, but the program is empty.`, {});
      return text(JSON.stringify(decompileProgram(program), null, 2));
    }
  )
);

const dslSchema = z
  .object({
    name: z.string(),
    variables: z
      .array(z.object({ name: z.string(), value: z.union([z.number(), z.string(), z.boolean()]).optional() }))
      .optional(),
    on: z.record(z.array(z.any())),
    requiresMfd: z.boolean().optional(),
  })
  .describe(
    'A program in the DSL: { name, on: { FlightStart: [ ["set-input","throttle",1], ["stage"] ] } }. ' +
      'Expressions are arrays: ["<", ["prop","Altitude.ASL"], 1000]. "$name" refers to a variable.'
  );

server.registerTool(
  'vizzy_write',
  {
    title: 'Write a flight program',
    description:
      'Compiles a program from the DSL into Vizzy XML and saves it — as a standalone file or embedded in a craft part. ' +
      'It assigns ids and styles itself. Takes a snapshot before writing.',
    inputSchema: {
      program: dslSchema,
      file: z.string().optional().describe('Save as a standalone file'),
      craft: z.string().optional().describe('Embed into a craft'),
      part_id: z.number().optional().describe('The computer part; defaults to the active command pod'),
      dry_run: z.boolean().optional().describe('Only compile and show the XML'),
      force: z.boolean().optional().describe('Write even while the game is running — do not use without permission'),
    },
  },
  guard(
    async ({
      program,
      file,
      craft,
      part_id,
      dry_run,
      force,
    }: {
      program: DslProgram;
      file?: string;
      craft?: string;
      part_id?: number;
      dry_run?: boolean;
      force?: boolean;
    }) => {
      const props = await craftPropertySet();
      const compiled = compileProgram(program, props);

      if (dry_run === true)
        return text(buildXml(compiled, GAME_FORMAT).replace(/\r/g, ''));

      const p = await gamePaths();

      if (file !== undefined) {
        const path = join(p.flightPrograms, `${assertSafeName(file, 'Program name')}.xml`);
        const snap = await guardedWrite('vizzy_write', path, buildXml(compiled, GAME_FORMAT), { force });
        return text(`Program "${program.name}" written to ${path}\nSnapshot to roll back to: ${snap.id}`);
      }

      if (craft === undefined)
        throw new ToolError('missing_target', 'Specify either file or craft.', {});

      const path = await craftPath(craft);
      const parsed = Craft.parse(await readFile(path, 'utf8'));
      const target =
        part_id !== undefined
          ? parsed.part(part_id)
          : parsed.parts.find((x) => x.modifiers.includes('FlightProgram')) ??
            parsed.parts.find((x) => x.modifiers.includes('CommandPod'));
      if (target === undefined)
        throw new ToolError(
          'no_computer',
          'The craft has no part able to carry a program (command pod, disk, chip or MFD).',
          {}
        );

      let holder = target.node.children.find((c) => c.tag === 'FlightProgram');
      if (holder === undefined) {
        holder = { tag: 'FlightProgram', attrs: {}, children: [] };
        target.node.children.push(holder);
      }
      holder.children = holder.children.filter((c) => c.tag !== 'Program');
      holder.children.push(compiled);

      const snap = await guardedWrite('vizzy_write', path, parsed.serialize(), { force });
      return text(
        `Program "${program.name}" embedded into part ${target.id} (${target.partType}) of craft "${craft}".\n` +
          `Snapshot to roll back to: ${snap.id}`
      );
    }
  )
);

// --- Launching the game and reading the log ---

server.registerTool(
  'game_launch',
  {
    title: 'Launch the game',
    description: 'Launches Juno and waits for the process to appear.',
    inputSchema: {},
  },
  guard(async () => {
    const r = await launchGame();
    return text(
      r.alreadyRunning
        ? `The game is already running (pid ${r.pid})`
        : r.pid !== undefined
          ? `Game launched (pid ${r.pid})`
          : 'Launch command sent, but the process did not appear within 15 s'
    );
  })
);

server.registerTool(
  'game_quit',
  {
    title: 'Quit the game',
    description: 'Asks the game to quit. Required before any write to the save files.',
    inputSchema: { force: z.boolean().optional().describe('Kill the process instead of quitting politely') },
  },
  guard(async ({ force }: { force?: boolean }) => {
    const r = await quitGame(force ?? false);
    return text(r.wasRunning ? 'Game quit' : 'The game was not running');
  })
);

server.registerTool(
  'log_read',
  {
    title: 'Read Player.log',
    description:
      'Reads the game log. By default shows only errors with their stacks, collapsing repeats — ' +
      'this is the main feedback channel until the bridge mod is installed.',
    inputSchema: {
      lines: z.number().optional(),
      filter: z.enum(['all', 'errors', 'mods']).optional(),
    },
  },
  guard(async ({ lines, filter }: { lines?: number; filter?: 'all' | 'errors' | 'mods' }) => {
    const r = await readLog({ lines, filter });
    return text(`${r.path} (${r.totalLines} lines)\n\n${r.returned}`);
  })
);

// --- Rollback ---

server.registerTool(
  'junoclaude_restore',
  {
    title: 'Roll back changes',
    description: 'Lists the snapshots taken before writes and restores the one you pick.',
    inputSchema: { snapshot_id: z.string().optional().describe('Without it — list only') },
  },
  guard(async ({ snapshot_id }: { snapshot_id?: string }) => {
    if (snapshot_id === undefined) {
      const all = await listSnapshots();
      if (all.length === 0) return text('No snapshots — nothing has been written yet.');
      return text(
        `Snapshots (newest first):\n${all
          .slice(0, 25)
          .map((s) => `  ${s.id}\n      ${s.files.map((f) => f.path).join(', ')}`)
          .join('\n')}`
      );
    }
    const m = await restoreSnapshot(snapshot_id);
    return text(`Restored from ${m.id}:\n${m.files.map((f) => `  ${f.path}`).join('\n')}`);
  })
);

await server.connect(new StdioServerTransport());
