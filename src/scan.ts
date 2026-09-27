/**
 * Find duplicate files by shared content, not by name.
 *
 * The pipeline has three stages, each of which throws away most of the input
 * cheaply, because the point is to be fast on a tree with a few hundred
 * thousand files in it:
 *
 *   1. size      -- files of different sizes cannot be duplicates. One stat.
 *   2. prefix    -- the first and last few KB, hashed together. Most
 *                   same-size files differ here and never get read again.
 *   3. chunks    -- only the survivors are chunked and hashed.
 *
 * Stage 3 gives partial matches: two files that share a large region are
 * reported with the shared bytes, which is how you find a file that was
 * copied into three places and then edited in two of them.
 */

import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { chunkBuffer, DEFAULT_CHUNK, type ChunkOptions } from './chunker.ts';

export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface DuplicateGroup {
  /** SHA-256 of the shared content, or of the whole file for an exact match. */
  key: string;
  files: FileEntry[];
  /** Bytes that would be reclaimed: total minus one copy. */
  wasted: number;
  kind: 'exact' | 'partial';
  /** Fraction of the file the group shares, 0-1. Always 1 for exact. */
  coverage: number;
}

export interface ScanOptions {
  minSize: number;
  maxSize: number;
  /** Bytes read from each end of a file for the quick-reject hash. */
  fingerprintSize: number;
  chunk: ChunkOptions;
  followSymlinks: boolean;
  exclude: RegExp[];
  includeHidden: boolean;
  /** Stop after this many duplicate groups. */
  limit: number;
}

/**
 * Above this many same-sized files, exhaustive pairwise comparison is not
 * worth it and only exact duplicates are reported.
 */
export const PARTIAL_CANDIDATE_LIMIT = 8;

export const DEFAULTS: ScanOptions = {
  minSize: 1,
  maxSize: Number.MAX_SAFE_INTEGER,
  fingerprintSize: 4096,
  chunk: DEFAULT_CHUNK,
  followSymlinks: false,
  exclude: [],
  includeHidden: false,
  limit: Number.MAX_SAFE_INTEGER,
};

export function hash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function excluded(path: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

/** Walk the tree, returning stat-able files. */
export async function walk(root: string, options: ScanOptions): Promise<FileEntry[]> {
  const found: FileEntry[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than abort the whole scan
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!options.includeHidden && entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      const display = relative(root, full).split(sep).join('/');

      if (excluded(display, options.exclude)) continue;

      if (entry.isSymbolicLink() && !options.followSymlinks) continue;

      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      // A Dirent reports the link itself, so a followed symlink is neither
      // isFile() nor isDirectory() -- it has to be stat()ed to find out what
      // it points at.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        if (info.size < options.minSize || info.size > options.maxSize) continue;
        found.push({ path: display, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        continue; // broken symlink, or a race with a delete
      }
    }
  }

  await visit(root);
  return found;
}

/** Hash the head and tail of a file, which rejects most same-size files. */
export async function fingerprint(path: string, size: number, bytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const length = Math.min(bytes, size);
    const head = new Uint8Array(length);
    await handle.read(head, 0, length, 0);

    if (size > length * 2) {
      const tail = new Uint8Array(length);
      await handle.read(tail, 0, length, size - length);
      return hash(Buffer.concat([head, tail]));
    }
    return hash(head);
  } finally {
    await handle.close();
  }
}

export async function readAll(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array((await handle.stat()).size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

interface ChunkRecord {
  key: string;
  path: string;
  index: number;
  size: number;
}

/** Hash every chunk of a file, keyed by size as well as content. */
export async function chunkHashes(path: string, options: ChunkOptions): Promise<string[]> {
  const data = await readAll(path);
  return chunkBuffer(data, options).map((chunk) => {
    // The size is part of the key so that a hash collision across different
    // chunk lengths cannot merge two unrelated chunks.
    const slice = data.subarray(chunk.offset, chunk.offset + chunk.length);
    return `${chunk.length}:${hash(slice)}`;
  });
}

/**
 * How many chunks two files have in common, counted anywhere in the file.
 *
 * Counting only a shared prefix would miss the common case: a file that was
 * copied and then edited at the *front* shares its entire tail, and its first
 * chunk, so a prefix comparison reports zero. Membership counting over a set
 * of SHA-256 chunk hashes handles an edit at either end. The chunks are large
 * enough that a hash collision between genuinely different content is not a
 * concern, and a chunk that appears twice within one file really is
 * duplicated content.
 */
function sharedChunkCount(a: string[], b: string[]): number {
  const available = new Set(b);
  let shared = 0;
  for (const key of a) if (available.has(key)) shared++;
  return shared;
}

export interface ScanResult {
  groups: DuplicateGroup[];
  filesScanned: number;
  bytesScanned: number;
  /** Files rejected by the size or fingerprint stage. */
  skipped: number;
  elapsedMs: number;
}

export async function scan(root: string, options: Partial<ScanOptions> = {}): Promise<ScanResult> {
  const settings = { ...DEFAULTS, ...options };
  const started = Date.now();

  const files = await walk(root, settings);

  // Stage 1: group by size.
  const bySize = new Map<number, FileEntry[]>();
  for (const file of files) {
    const bucket = bySize.get(file.size);
    if (bucket) bucket.push(file);
    else bySize.set(file.size, [file]);
  }

  const candidates = [...bySize.values()].filter((bucket) => bucket.length > 1);

  // Stage 2: reject most same-size files on a cheap head+tail hash, then
  // stage 3: chunk and compare what is left.
  //
  // Buckets are handled one way or the other, never both, so a pair cannot be
  // reported twice. A bucket small enough to compare exhaustively is compared
  // whole, which is also what makes the edited-copy case reachable: the
  // fingerprint proves two files are not identical, but that is exactly the
  // pair worth reporting as a near match. Above the limit the cost of every
  // pairwise comparison wins, so only the fingerprint survivors are compared
  // and only exact duplicates are reported.
  const toCompare: FileEntry[][] = [];
  let skipped = 0;

  for (const bucket of candidates) {
    if (bucket.length > PARTIAL_CANDIDATE_LIMIT) {
      const byFingerprint = new Map<string, FileEntry[]>();
      for (const file of bucket) {
        const key = await fingerprint(
          join(root, file.path),
          file.size,
          settings.fingerprintSize,
        );
        const group = byFingerprint.get(key);
        if (group) group.push(file);
        else byFingerprint.set(key, [file]);
      }
      skipped += bucket.length;
      toCompare.push(...[...byFingerprint.values()].filter((g) => g.length > 1));
    } else {
      skipped += bucket.length;
      toCompare.push(bucket);
    }
  }

  const groups: DuplicateGroup[] = [];

  for (const bucket of toCompare) {
    const chunked = new Map<string, string[]>();
    for (const file of bucket) {
      chunked.set(file.path, await chunkHashes(join(root, file.path), settings.chunk));
    }

    // Files whose every chunk matches are byte-identical. This is settled
    // first and for the whole bucket, because a file that is an exact
    // duplicate of something is already accounted for and should not also be
    // reported as a near match of it.
    const exact = new Map<string, FileEntry[]>();
    for (const file of bucket) {
      const key = chunked.get(file.path)!.join(',');
      const group = exact.get(key);
      if (group) group.push(file);
      else exact.set(key, [file]);
    }

    const reported = new Set<string>();
    for (const [key, members] of exact) {
      if (members.length < 2) continue;
      reported.add(members[0].path);
      for (const file of members) reported.add(file.path);
      groups.push({
        key: hash(Buffer.from(key)),
        files: members,
        wasted: fileSize(members) - members[0].size,
        kind: 'exact',
        coverage: 1,
      });
    }

    const remaining = bucket.filter((file) => !reported.has(file.path));
    if (remaining.length > 1) {
      const partial = findBestPartial(remaining, chunked);
      if (partial) groups.push(partial);
    }
  }

  groups.sort((a, b) => b.wasted - a.wasted);

  return {
    groups: groups.slice(0, settings.limit),
    filesScanned: files.length,
    bytesScanned: files.reduce((total, file) => total + file.size, 0),
    skipped,
    elapsedMs: Date.now() - started,
  };
}

function fileSize(files: FileEntry[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function findBestPartial(
  bucket: FileEntry[],
  chunked: Map<string, string[]>,
): DuplicateGroup | null {
  let best: DuplicateGroup | null = null;

  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      const a = chunked.get(bucket[i].path)!;
      const b = chunked.get(bucket[j].path)!;
      const sharedChunks = sharedChunkCount(a, b);
      if (sharedChunks === 0) continue;

      // Chunks are roughly the same size, so the matched count scales
      // directly to bytes. Weighting by the shorter file keeps the coverage
      // from exceeding 1 for the pair.
      const shared = (sharedChunks * Math.min(bucket[i].size, bucket[j].size)) / Math.max(a.length, b.length);
      // Only worth reporting if the shared part is a meaningful fraction.
      if (shared / bucket[i].size < 0.5) continue;

      const candidate: DuplicateGroup = {
        key: hash(Buffer.from(`${a.slice(0, sharedChunks).join(',')}`)),
        files: [bucket[i], bucket[j]],
        // Reclaiming space on a partial match is not automatic: the two files
        // are not interchangeable, so this reports the overlap rather than
        // offering to act on it.
        wasted: Math.round(shared) / 2,
        kind: 'partial',
        coverage: shared / bucket[i].size,
      };
      if (!best || candidate.wasted > best.wasted) best = candidate;
    }
  }

  return best;
}
