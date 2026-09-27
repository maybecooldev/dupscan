/**
 * Content-defined chunking.
 *
 * Fixed-size blocks are the obvious way to split a file for deduplication and
 * they are wrong in a way that matters: inserting a byte near the start shifts
 * every subsequent boundary, so a file that differs only at the front shares
 * no chunks with the original. The copy is still flagged, but a small edit to
 * a large file loses all the deduplication benefit.
 *
 * A rolling hash fixes this. The chunk boundary is wherever the hash of the
 * last WINDOW bytes falls below a threshold, so boundaries are determined by
 * content rather than position. Insert a byte and the boundaries after it move
 * by one, but they still land in the same place relative to the surrounding
 * content -- which is what lets the two files share chunks.
 *
 * This is the approach rsync, bup and restic use. It costs a rolling hash per
 * byte and saves a great deal of storage.
 */

/** Number of bytes the rolling hash looks back over. */
const WINDOW = 48;

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** Ring of the last WINDOW bytes, pre-filled with zeros. */
class RingBuffer {
  private readonly table: Uint8Array;
  private start = 0;

  constructor(capacity: number) {
    this.table = new Uint8Array(capacity);
  }

  /** The byte that is about to leave the window. */
  peek(): number {
    return this.table[this.start];
  }

  push(byte: number): void {
    this.table[this.start] = byte;
    this.start = (this.start + 1) % this.table.length;
  }
}

/**
 * Gear table: 256 pseudorandom 32-bit words, one per byte value.
 *
 * The randomness is what makes the hash content-dependent. The rolling update
 * keeps
 *
 *     h = XOR over the window of rotl(GEAR[byte], age)
 *
 * so a byte contributes differently depending on how far back it is, and
 * moving the window forward leaves the relative positions intact. That is
 * what lets an insertion shift the boundaries by one byte instead of
 * re-cutting the whole file.
 */
function gearTable(): Uint32Array {
  const table = new Uint32Array(256);
  // A fixed linear congruential sequence, so every machine agrees on the
  // table and chunk boundaries are reproducible across runs and platforms.
  // An arbitrary table is fine for finding duplicates in one directory, but a
  // stable one means scanning the same data twice gives the same chunks.
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    table[i] = state;
  }
  return table;
}

const GEAR = gearTable();

/**
 * The hash of a window that has not been filled yet.
 *
 * The ring buffer starts as WINDOW zero bytes, so the digest has to start as
 * the hash of those zeros. Starting from zero instead would bias the first
 * WINDOW bytes of every file towards cutting immediately, which is exactly
 * the degenerate behaviour this whole scheme exists to avoid.
 */
const EMPTY_DIGEST = (() => {
  let digest = 0;
  for (let age = 0; age < WINDOW; age++) digest = rotl(digest, 1) ^ rotl(GEAR[0], age);
  return digest >>> 0;
})();

export interface ChunkOptions {
  /** Average chunk size, in bytes. The usual trade: smaller finds more
   *  duplicates, larger means fewer hashes and less overhead. */
  averageSize: number;
  /** Never emit a chunk smaller than this, however the hash falls. */
  minSize: number;
  /** Never emit a chunk larger than this; the boundary is forced. */
  maxSize: number;
}

export const DEFAULT_CHUNK: ChunkOptions = {
  averageSize: 64 * 1024,
  minSize: 16 * 1024,
  maxSize: 256 * 1024,
};

export interface Chunk {
  offset: number;
  length: number;
  /** Set for the final chunk of a file, which may be short. */
  last: boolean;
}

/**
 * Decide where to cut.
 *
 * The boundary is wherever the low bits of the rolling hash are clear, which
 * on data that looks random happens once in `averageSize` bytes on average.
 * The mask is derived from the requested average rather than hard-coded, so
 * `--avg-chunk` actually changes the chunk size.
 */
function maskFor(averageSize: number): number {
  const bits = Math.max(4, Math.min(30, Math.round(Math.log2(Math.max(2, averageSize)))));
  return (1 << bits) - 1;
}

/** Split a buffer into content-defined chunks. */
export function chunkBuffer(data: Uint8Array, options: ChunkOptions = DEFAULT_CHUNK): Chunk[] {
  const mask = maskFor(options.averageSize);
  const chunks: Chunk[] = [];
  const { minSize, maxSize } = options;

  let offset = 0;
  while (offset < data.length) {
    const remaining = data.length - offset;
    if (remaining <= minSize) {
      chunks.push({ offset, length: remaining, last: true });
      break;
    }

    const limit = Math.min(maxSize, remaining);
    const window = new RingBuffer(WINDOW);
    let hash = EMPTY_DIGEST;
    let cut = offset + limit;

    for (let i = offset; i < offset + limit; i++) {
      const byte = data[i];
      // Roll the window forward by one and swap the byte leaving it.
      hash = rotl(hash, 1) ^ rotl(GEAR[window.peek()], WINDOW) ^ GEAR[byte];
      window.push(byte);

      if (i - offset + 1 >= minSize && (hash & mask) === 0) {
        cut = i + 1;
        break;
      }
    }

    chunks.push({ offset, length: cut - offset, last: cut >= data.length });
    offset = cut;
  }

  return chunks;
}

export function chunksOf(data: Uint8Array, options?: ChunkOptions): Chunk[] {
  return chunkBuffer(data, options);
}
