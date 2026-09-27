import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.ts';

let root: string;

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** Run the CLI with stdout captured, so the report can be asserted on. */
async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const chunks: string[] = [];
  const errors: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: chunks.join(''), err: errors.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dupscan-cli-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function tree(name: string, files: Record<string, Uint8Array | string>) {
  const base = join(root, name);
  await mkdir(base, { recursive: true });
  for (const [relative, data] of Object.entries(files)) {
    await mkdir(join(base, relative, '..'), { recursive: true });
    await writeFile(join(base, relative), data);
  }
  return base;
}

describe('reporting', () => {
  test('a clean tree exits 0 and says so', async () => {
    const base = await tree('clean', { a: bytes(1000, 1), b: bytes(2000, 2) });
    const { code, out } = await run(base);
    assert.equal(code, 0);
    assert.match(out, /no duplicates found/);
  });

  test('duplicates exit 1', async () => {
    const data = bytes(50_000, 7);
    const base = await tree('dupes', { one: data, two: data });
    const { code, out } = await run(base);
    assert.equal(code, 1);
    assert.match(out, /2 file\(s\), exact/);
    assert.match(out, /one/);
    assert.match(out, /two/);
  });

  test('the summary reports reclaimable space', async () => {
    const data = bytes(20_000, 8);
    const base = await tree('space', { a: data, b: data });
    const { out } = await run(base);
    assert.match(out, /total reclaimable: 20 KiB/);
    assert.match(out, /%/);
  });

  test('json output parses and carries the group structure', async () => {
    const data = bytes(50_000, 9);
    const base = await tree('json', { a: data, b: data });
    const { out } = await run(base, '--json');
    const payload = JSON.parse(out);
    assert.equal(payload.groups.length, 1);
    assert.equal(payload.groups[0].kind, 'exact');
    assert.equal(payload.groups[0].files.length, 2);
    assert.ok(payload.groups[0].files[0].path);
  });

  test('human sizes are used, not raw bytes', async () => {
    const data = bytes(200_000, 10);
    const base = await tree('human', { a: data, b: data });
    const { out } = await run(base);
    assert.match(out, /KiB/);
  });
});

describe('options', () => {
  test('min-size is understood with a suffix', async () => {
    const base = await tree('minsize', { a: 'tiny', b: 'tiny' });
    assert.equal((await run(base)).code, 1);
    assert.equal((await run(base, '-m', '1M')).code, 0);
  });

  test('exclude patterns filter paths', async () => {
    const data = bytes(30_000, 11);
    const base = await tree('exclude', { 'keep': data, 'skip/also': data });
    assert.equal((await run(base)).code, 1);
    assert.equal((await run(base, '-e', 'skip/')).code, 0);
  });

  test('a bad size is a usage error', async () => {
    const base = await tree('badsize', { a: 'x' });
    const { code, err } = await run(base, '-m', 'banana');
    assert.equal(code, 2);
    assert.match(err, /not a size/);
  });

  test('help exits successfully', async () => {
    const { code, out } = await run('--help');
    assert.equal(code, 0);
    assert.match(out, /dupscan/);
  });

  test('limit caps the report', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 4; i++) {
      const data = bytes(5000, 200 + i);
      files[`x${i}a`] = data;
      files[`x${i}b`] = data;
    }
    const base = await tree('limit', files);
    const { out } = await run(base, '--json', '--limit', '2');
    assert.equal(JSON.parse(out).groups.length, 2);
  });
});

describe('reclaiming space', () => {
  test('hardlinking keeps every path readable', async () => {
    const data = bytes(40_000, 12);
    const base = await tree('hardlink', { keeper: data, spare: data });

    // Reclaim, then confirm both paths still read the same bytes.
    const keeperPath = join(base, 'keeper');
    await rm(join(base, 'spare'));
    await link(keeperPath, join(base, 'spare'));

    assert.deepEqual(new Uint8Array(await readFile(join(base, 'spare'))), data);
    assert.deepEqual(new Uint8Array(await readFile(keeperPath)), data);
    const info = await stat(join(base, 'spare'));
    assert.equal(info.nlink, 2, 'the two paths should be one inode');
  });

  test('a dry run changes nothing but says it would act', async () => {
    const data = bytes(40_000, 13);
    const base = await tree('dryrun', { a: data, b: data });
    const before = (await stat(join(base, 'b'))).ino;
    const { out } = await run(base, '--dry-run');
    assert.match(out, /dry run: nothing was changed/);
    assert.equal((await stat(join(base, 'b'))).ino, before);
  });
});
