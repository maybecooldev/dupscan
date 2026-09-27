import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scan, walk, hash, DEFAULTS } from '../src/scan.ts';

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

async function file(relative: string, data: Uint8Array | string) {
  const path = join(root, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, data);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dupscan-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('walk', () => {
  test('finds files recursively and reports them relative', async () => {
    const base = join(root, 'walk');
    await mkdir(join(base, 'sub'), { recursive: true });
    await writeFile(join(base, 'a.txt'), 'a');
    await writeFile(join(base, 'sub', 'b.txt'), 'b');

    const found = await walk(base, DEFAULTS);
    assert.deepEqual(found.map((f) => f.path).sort(), ['a.txt', 'sub/b.txt']);
  });

  test('skips dotfiles unless asked', async () => {
    const base = join(root, 'hidden');
    await mkdir(join(base, '.git'), { recursive: true });
    await writeFile(join(base, '.git', 'config'), 'x');
    await writeFile(join(base, 'visible'), 'x');

    assert.deepEqual((await walk(base, DEFAULTS)).map((f) => f.path), ['visible']);
    const withHidden = await walk(base, { ...DEFAULTS, includeHidden: true });
    assert.equal(withHidden.length, 2);
  });

  test('applies exclude patterns', async () => {
    const base = join(root, 'excluded');
    await mkdir(join(base, 'node_modules'), { recursive: true });
    await writeFile(join(base, 'node_modules', 'x.js'), 'x');
    await writeFile(join(base, 'keep.js'), 'x');

    const found = await walk(base, { ...DEFAULTS, exclude: [/node_modules/] });
    assert.deepEqual(found.map((f) => f.path), ['keep.js']);
  });

  test('skips symlinks unless asked to follow them', async () => {
    const base = join(root, 'links');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'real.txt'), 'hello');
    await symlink(join(base, 'real.txt'), join(base, 'link.txt'));

    assert.deepEqual((await walk(base, DEFAULTS)).map((f) => f.path), ['real.txt']);
    const followed = await walk(base, { ...DEFAULTS, followSymlinks: true });
    assert.equal(followed.length, 2);
  });

  test('an unreadable directory does not abort the walk', async () => {
    const base = join(root, 'unreadable');
    await mkdir(join(base, 'locked'), { recursive: true });
    await writeFile(join(base, 'ok.txt'), 'x');
    // A path that does not exist: walk() should return an empty list quietly.
    assert.deepEqual(await walk(join(base, 'nope'), DEFAULTS), []);
  });
});

describe('hashing', () => {
  test('hash is stable and content-addressed', () => {
    assert.equal(hash(new Uint8Array([1, 2, 3])), hash(new Uint8Array([1, 2, 3])));
    assert.notEqual(hash(new Uint8Array([1, 2, 3])), hash(new Uint8Array([1, 2, 4])));
  });
});

describe('finding exact duplicates', () => {
  test('identical files are grouped', async () => {
    const base = join(root, 'exact');
    await mkdir(base, { recursive: true });
    const data = bytes(50_000, 7);
    await writeFile(join(base, 'one.bin'), data);
    await writeFile(join(base, 'two.bin'), data);
    await writeFile(join(base, 'three.bin'), bytes(50_000, 8));

    const result = await scan(base);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].kind, 'exact');
    assert.equal(result.groups[0].files.length, 2);
    assert.deepEqual(
      result.groups[0].files.map((f) => f.path).sort(),
      ['one.bin', 'two.bin'],
    );
  });

  test('reclaimable space is total minus one copy', async () => {
    const base = join(root, 'wasted');
    await mkdir(base, { recursive: true });
    const data = bytes(10_000, 3);
    await writeFile(join(base, 'a'), data);
    await writeFile(join(base, 'b'), data);
    await writeFile(join(base, 'c'), data);

    const [group] = (await scan(base)).groups;
    assert.equal(group.wasted, 20_000);
  });

  test('a clean tree reports nothing', async () => {
    const base = join(root, 'clean');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'a'), bytes(1000, 1));
    await writeFile(join(base, 'b'), bytes(2000, 2));
    const result = await scan(base);
    assert.deepEqual(result.groups, []);
  });

  test('files of different sizes are never compared', async () => {
    const base = join(root, 'sizes');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'a'), bytes(1000, 1));
    await writeFile(join(base, 'b'), bytes(1001, 1));
    assert.deepEqual((await scan(base)).groups, []);
  });

  test('same size but different content is not a duplicate', async () => {
    const base = join(root, 'different');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'a'), bytes(5000, 11));
    await writeFile(join(base, 'b'), bytes(5000, 22));
    assert.deepEqual((await scan(base)).groups, []);
  });

  test('min-size filters small files out', async () => {
    const base = join(root, 'min-size');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'a'), 'tiny');
    await writeFile(join(base, 'b'), 'tiny');
    assert.equal((await scan(base)).groups.length, 1);
    assert.equal((await scan(base, { minSize: 1000 })).groups.length, 0);
  });

  test('limit caps the number of groups', async () => {
    const base = join(root, 'limit');
    await mkdir(base, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const data = bytes(5000, 100 + i);
      await writeFile(join(base, `x${i}a`), data);
      await writeFile(join(base, `x${i}b`), data);
    }
    const result = await scan(base, { limit: 2 });
    assert.equal(result.groups.length, 2);
  });
});

describe('counting', () => {
  test('reports what it scanned', async () => {
    const base = join(root, 'counting');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'a'), bytes(1000, 1));
    await writeFile(join(base, 'b'), bytes(2000, 2));
    await writeFile(join(base, 'c'), bytes(2000, 2));

    const result = await scan(base);
    assert.equal(result.filesScanned, 3);
    assert.equal(result.bytesScanned, 5000);
  });
});

describe('partial matches', () => {
  test('a copy with a small edit at the front is reported as partial', async () => {
    const base = join(root, 'partial');
    await mkdir(base, { recursive: true });
    // Big enough that one 64 KiB chunk is a small fraction of the file: the
    // coverage figure is quantised by the chunk size, so a 200 KB file would
    // report 50% for what is really a 0.5% edit.
    const original = bytes(4_000_000, 42);
    const edited = new Uint8Array(original);
    for (let i = 0; i < 1000; i++) edited[i] ^= 0xff;
    await writeFile(join(base, 'original'), original);
    await writeFile(join(base, 'edited'), edited);

    const result = await scan(base);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].kind, 'partial');
    assert.ok(
      result.groups[0].coverage > 0.95,
      `coverage ${result.groups[0].coverage} for a 0.025% edit`,
    );
  });

  test('a file already reported as an exact duplicate is not also a near match', async () => {
    const base = join(root, 'not-double-reported');
    await mkdir(base, { recursive: true });
    const original = bytes(400_000, 51);
    const edited = new Uint8Array(original);
    for (let i = 0; i < 1000; i++) edited[i] ^= 0xff;
    await writeFile(join(base, 'a'), original);
    await writeFile(join(base, 'a-copy'), original);
    await writeFile(join(base, 'a-edited'), edited);

    const result = await scan(base);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].kind, 'exact');
    assert.equal(result.groups[0].files.length, 2);
  });

  test('two unrelated large files are not a partial match', async () => {
    const base = join(root, 'unrelated');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'a'), bytes(4_000_000, 5));
    await writeFile(join(base, 'b'), bytes(4_000_000, 6));
    assert.deepEqual((await scan(base)).groups, []);
  });
});

describe('tolerance', () => {
  test('a file that is not valid utf-8 is still hashed', async () => {
    const base = join(root, 'binary');
    await mkdir(base, { recursive: true });
    const data = bytes(8000, 9);
    await writeFile(join(base, 'a'), data);
    await writeFile(join(base, 'b'), data);
    assert.equal((await scan(base)).groups.length, 1);
  });

  test('a large file is chunked rather than rejected', async () => {
    const base = join(root, 'large');
    await mkdir(base, { recursive: true });
    const data = bytes(2_000_000, 21);
    await writeFile(join(base, 'a'), data);
    await writeFile(join(base, 'b'), data);
    const [group] = (await scan(base)).groups;
    assert.equal(group.kind, 'exact');
    assert.equal((await stat(join(base, 'a'))).size, 2_000_000);
  });
});
