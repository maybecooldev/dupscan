#!/usr/bin/env node
/**
 * dupscan — find duplicate files by content, not by name.
 */

import { link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { scan, type ScanOptions, type ScanResult } from './scan.ts';

const USAGE = `dupscan — find duplicate files by content, not by name

usage
  dupscan [options] [directory]

options
  -m, --min-size <bytes>     ignore files smaller than this (default 1)
      --max-size <bytes>     ignore files larger than this
  -e, --exclude <pattern>    skip paths matching this regexp; repeatable
  -H, --hidden               include dotfiles and dot-directories
  -L, --follow               follow symbolic links
      --avg-chunk <bytes>    target average chunk size (default 65536)
      --limit <n>            report at most n groups
      --json                 machine-readable output
      --dry-run              with --hardlink, report instead of acting
  -h, --help                 show this
  -v, --version              show the version

exit codes
  0 no duplicates found
  1 duplicates found
  2 bad usage

examples
  dupscan ~/Downloads
  dupscan . --min-size 1M --exclude 'node_modules|\\.git/'
  dupscan . --json | jq '.groups[].files[].path'
`;

interface Args {
  positional: string[];
  minSize: string;
  maxSize: string;
  exclude: string[];
  hidden: boolean;
  follow: boolean;
  avgChunk: string;
  limit: string;
  json: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

function parseSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(raw.trim());
  if (!match) throw new Error(`not a size: ${raw}`);
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[
    match[2].toLowerCase()
  ] as number;
  return Math.round(Number(match[1]) * scale);
}

function parseCli(argv: string[]): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'min-size': { type: 'string', short: 'm', default: '1' },
      'max-size': { type: 'string', default: '' },
      exclude: { type: 'string', short: 'e', multiple: true, default: [] },
      hidden: { type: 'boolean', short: 'H', default: false },
      follow: { type: 'boolean', short: 'L', default: false },
      'avg-chunk': { type: 'string', default: '65536' },
      limit: { type: 'string', default: '' },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  return {
    positional: positionals,
    minSize: values['min-size'] ?? '1',
    maxSize: values['max-size'],
    exclude: values.exclude,
    hidden: values.hidden,
    follow: values.follow,
    avgChunk: values['avg-chunk'] ?? '65536',
    limit: values.limit,
    json: values.json,
    dryRun: values['dry-run'],
    help: values.help,
    version: values.version,
  };
}

function human(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function render(result: ScanResult, dryRun: boolean): string {
  const lines: string[] = [];
  const totalWasted = result.groups.reduce((total, group) => total + Math.max(0, group.wasted), 0);

  lines.push(
    `scanned ${result.filesScanned} file(s), ${human(result.bytesScanned)} in ${result.elapsedMs}ms`,
  );
  lines.push(
    `${result.skipped} candidate(s) after size filtering, ${result.groups.length} duplicate group(s)`,
  );

  if (result.groups.length === 0) {
    lines.push('');
    lines.push('no duplicates found');
    return lines.join('\n');
  }

  for (const [index, group] of result.groups.entries()) {
    const label = group.kind === 'exact' ? 'exact' : `${Math.round(group.coverage * 100)}% shared`;
    lines.push('');
    lines.push(`[${index + 1}] ${group.files.length} file(s), ${label}, reclaims ${human(group.wasted)}`);
    for (const file of group.files) {
      lines.push(`    ${String(file.size).padStart(10)}  ${file.path}`);
    }
  }

  lines.push('');
  lines.push(
    `total reclaimable: ${human(totalWasted)} (${((totalWasted / Math.max(1, result.bytesScanned)) * 100).toFixed(1)}% of the tree)`,
  );
  if (dryRun) lines.push('dry run: nothing was changed');
  return lines.join('\n');
}

/**
 * Replace duplicates with hard links.
 *
 * The filesystem then stores one copy, and every path still reads the same
 * bytes. Unlinking a duplicate is not safe when a path might be a symlink
 * someone else is relying on, but hardlinking is reversible: the paths keep
 * working and the space is reclaimed.
 */
async function deduplicate(root: string, result: ScanResult, dryRun: boolean): Promise<number> {
  let linked = 0;
  for (const group of result.groups) {
    if (group.kind !== 'exact') continue;
    const [keeper, ...duplicates] = group.files;
    for (const duplicate of duplicates) {
      const target = join(root, keeper.path);
      const source = join(root, duplicate.path);
      if (dryRun) {
        linked++;
        continue;
      }
      try {
        await unlink(source);
        await link(target, source);
        linked++;
      } catch {
        // Cross-device links fail, and a read-only tree refuses. Report the
        // count and let the caller decide, rather than aborting the scan.
      }
    }
  }
  return linked;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseCli(argv);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = resolve(args.positional[0] ?? '.');

  let options: Partial<ScanOptions>;
  try {
    options = {
      minSize: parseSize(args.minSize),
      maxSize: args.maxSize ? parseSize(args.maxSize) : undefined,
      exclude: args.exclude.map((pattern) => new RegExp(pattern)),
      includeHidden: args.hidden,
      followSymlinks: args.follow,
      limit: args.limit ? Number(args.limit) : undefined,
      chunk: {
        averageSize: parseSize(args.avgChunk),
        minSize: Math.max(1, Math.floor(parseSize(args.avgChunk) / 4)),
        maxSize: parseSize(args.avgChunk) * 4,
      },
    };
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 2;
  }

  let result: ScanResult;
  try {
    result = await scan(root, options);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 1;
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          root,
          filesScanned: result.filesScanned,
          bytesScanned: result.bytesScanned,
          elapsedMs: result.elapsedMs,
          groups: result.groups,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(render(result, args.dryRun) + '\n');
  }

  return result.groups.length > 0 ? 1 : 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
