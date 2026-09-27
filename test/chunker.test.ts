import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { createHash } from 'node:crypto';

import { chunkBuffer, DEFAULT_CHUNK, type ChunkOptions } from '../src/chunker.ts';

const OPTIONS: ChunkOptions = { averageSize: 4096, minSize: 512, maxSize: 16384 };

function bytes(length: number, seed = 1): Uint8Array {
  // xorshift, so the data is deterministic across runs but not compressible
  // into a constant that would make every chunk boundary land in the same place.
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

function chunkKeys(data: Uint8Array, options = OPTIONS): string[] {
  return chunkBuffer(data, options).map((c) => `${c.offset}:${c.length}`);
}

/**
 * Identity of a chunk by its bytes, which is what the scanner compares.
 * Offsets are deliberately excluded: inserting a byte at the front shifts
 * every offset by one, and a key that includes the offset could never match
 * no matter how good the boundary detection is.
 */
function contentKeys(data: Uint8Array, options = OPTIONS): string[] {
  return chunkBuffer(data, options).map((chunk) => {
    const slice = data.subarray(chunk.offset, chunk.offset + chunk.length);
    return `${chunk.length}:${createHash('sha256').update(slice).digest('hex')}`;
  });
}

describe('chunking basics', () => {
  test('an empty buffer produces no chunks', () => {
    assert.deepEqual(chunkBuffer(new Uint8Array(0), OPTIONS), []);
  });

  test('a small buffer is one final chunk', () => {
    const [chunk] = chunkBuffer(bytes(100), OPTIONS);
    assert.equal(chunk.length, 100);
    assert.equal(chunk.last, true);
  });

  test('chunks tile the buffer exactly, with no gaps or overlap', () => {
    const data = bytes(100_000);
    const chunks = chunkBuffer(data, OPTIONS);
    let offset = 0;
    for (const chunk of chunks) {
      assert.equal(chunk.offset, offset);
      offset += chunk.length;
    }
    assert.equal(offset, data.length);
  });

  test('only the final chunk is marked last', () => {
    const chunks = chunkBuffer(bytes(100_000), OPTIONS);
    assert.equal(chunks[chunks.length - 1].last, true);
    assert.ok(chunks.slice(0, -1).every((chunk) => chunk.last === false));
  });

  test('min and max sizes are respected', () => {
    const chunks = chunkBuffer(bytes(200_000), OPTIONS);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= OPTIONS.maxSize, `chunk of ${chunk.length} over max`);
      // The last chunk may be short; nothing else may be.
      if (!chunk.last) assert.ok(chunk.length >= OPTIONS.minSize);
    }
  });
});

describe('content-defined boundaries', () => {
  test('the same bytes always chunk the same way', () => {
    const data = bytes(50_000);
    assert.deepEqual(chunkKeys(data), chunkKeys(data));
  });

  test('different data gives different boundaries', () => {
    assert.notDeepEqual(chunkKeys(bytes(50_000, 1)), chunkKeys(bytes(50_000, 2)));
  });

  test('boundaries land near the target average', () => {
    const data = bytes(1_000_000);
    const chunks = chunkBuffer(data, OPTIONS);
    const average = data.length / chunks.length;
    // Gear hashing is a geometric distribution, so the mean is the target but
    // individual chunks vary widely. A factor of three either way is a
    // reasonable envelope for 250 samples.
    assert.ok(average > OPTIONS.averageSize / 3, `average ${average} too low`);
    assert.ok(average < OPTIONS.averageSize * 3, `average ${average} too high`);
  });

  test('a smaller average size produces more chunks', () => {
    const data = bytes(200_000);
    const coarse = chunkBuffer(data, { averageSize: 16384, minSize: 2048, maxSize: 65536 });
    const fine = chunkBuffer(data, { averageSize: 2048, minSize: 256, maxSize: 8192 });
    assert.ok(fine.length > coarse.length);
  });
});

describe('the property that justifies content-defined chunking', () => {
  // This is the whole reason for not using fixed-size blocks. With fixed
  // blocks, inserting a byte at the front shifts every boundary and the two
  // files share nothing. With a rolling hash, the boundaries after the
  // insertion move by one byte but still sit between the same content, so the
  // unchanged tail keeps its chunks.
  test('prepending a byte still leaves most chunks shared', () => {
    const original = bytes(300_000);
    const shifted = new Uint8Array(original.length + 1);
    shifted[0] = 0x42;
    shifted.set(original, 1);

    const a = contentKeys(original);
    const b = contentKeys(shifted);

    const shared = new Set(b);
    const inCommon = a.filter((key) => shared.has(key)).length;
    const ratio = inCommon / a.length;
    assert.ok(ratio > 0.7, `only ${(ratio * 100).toFixed(0)}% of chunks shared`);
  });

  test('inserting in the middle also preserves the tail', () => {
    const original = bytes(300_000);
    const edited = new Uint8Array(original.length + 100);
    edited.set(original.subarray(0, 150_000), 0);
    edited.set(original.subarray(150_000), 150_100);

    const a = contentKeys(original);
    const b = contentKeys(edited);
    const shared = new Set(b);
    const tail = a.filter((key) => shared.has(key));
    assert.ok(tail.length > 0.5 * a.length, `${tail.length}/${a.length} chunks shared`);
  });
});

describe('degenerate input', () => {
  test('all-zero data still terminates and tiles', () => {
    const data = new Uint8Array(100_000);
    const chunks = chunkBuffer(data, OPTIONS);
    let offset = 0;
    for (const chunk of chunks) {
      assert.equal(chunk.offset, offset);
      offset += chunk.length;
    }
    assert.equal(offset, data.length);
  });

  test('no chunk ever exceeds the forced maximum', () => {
    const data = bytes(10_000);
    const chunks = chunkBuffer(data, { averageSize: 1024, minSize: 1, maxSize: 1024 });
    assert.ok(chunks.every((chunk) => chunk.length <= 1024));
    assert.ok(chunks.length >= 10, `${chunks.length} chunks for 10000 bytes at max 1024`);
  });
});

describe('defaults', () => {
  test('the default chunk size is 64 KiB', () => {
    assert.equal(DEFAULT_CHUNK.averageSize, 64 * 1024);
  });
});
