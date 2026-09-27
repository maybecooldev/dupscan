# dupscan

Find duplicate files by content, not by name.

```sh
dupscan ~/Downloads
```

```
scanned 318 file(s), 214 MiB in 412ms
47 candidate(s) after size filtering, 6 duplicate group(s)

[1] 3 file(s), exact, reclaims 48.2 MiB
    52428800  photos/2024/raw/DSC_0042.CR2
    52428800  photos/2024/raw/DSC_0042 (copy).CR2
    52428800  backups/2024-06/raw/DSC_0042.CR2

total reclaimable: 91.4 MiB (42.7% of the tree)
```

Exits `1` when duplicates are found, so it drops straight into CI or a
pre-commit hook.

## Why chunking

The obvious way to deduplicate is to compare files byte by byte, or to hash
each file whole. Both have the same weakness: a file that was copied and then
edited somewhere in the middle looks completely different from the original,
and you get no report at all — even though 99% of the bytes are shared.

Fixed-size blocks fix part of that and introduce a worse problem. Cut a file
into 64 KiB blocks and insert one byte at the front, and every boundary after
it shifts by one. The two files now share no blocks at all.

**Content-defined chunking** cuts where the *content* says to, not where the
position does. `dupscan` rolls a Gear hash over a 48-byte window and cuts
whenever the low bits of the hash come up clear, so a boundary lands between
the same two bytes no matter what precedes it. Insert a byte at the front and
the boundaries after it move by one and then resynchronise — and the rest of
the file keeps its chunks.

That is the approach rsync, bup and restic use, and it is why this finds the
edited copies that a whole-file hash misses. The test suite asserts the
property directly: prepending one byte to a 300 KB buffer must leave more than
70% of its chunks shared.

## How the scan works

Three stages, each discarding most of the input cheaply:

1. **Size.** Files of different sizes cannot be duplicates. One `stat` each.
2. **Fingerprint.** The first and last 4 KiB, hashed together. Most same-size
   files differ here and are never read again.
3. **Chunks.** Survivors are chunked and each chunk hashed with SHA-256. The
   size is part of the chunk key, so a collision across different chunk
   lengths cannot merge unrelated chunks.

Stage 2 is a fast way to prove two files are *not* identical, but that is
exactly the pair worth reporting as a near match. For size buckets of up to 8
files the comparison runs across the fingerprint split anyway; above that the
cost of every pairwise comparison wins and only exact duplicates are reported.
The threshold is `PARTIAL_CANDIDATE_LIMIT` in `src/scan.ts`.

## Partial matches

Two files that share most of their chunks but are not identical are reported
with the fraction they share:

```
[1] 2 file(s), 97% shared, reclaims 4.8 MiB
     52428800  report-2024.pdf
     52428800  report-2024-final.pdf
```

Coverage is quantised by the chunk size — one 64 KiB chunk is 1% of a 4 MB
file and 25% of a 256 KB one. A small file can only be reported in coarse
steps, which is the trade for not reading the whole file.

Partial matches are **reported, not acted on**. Two files that are 97% the
same are not interchangeable, and hardlinking them would silently corrupt one
of them. Only exact matches are safe to deduplicate.

## Reclaiming space

```sh
dupscan ~/Downloads --dry-run
```

`--dry-run` is the default posture: the tool reports, you decide. The
`deduplicate` function that replaces duplicates with hard links is deliberately
not wired to a flag yet — hardlinking is reversible (the paths keep working
and the space comes back), but it is still a destructive-looking action on
someone's data, and it deserves a flag that says so out loud.

A hard link is the right primitive when you do act: the filesystem stores one
copy, every path still reads the same bytes, and nothing breaks.

## Usage

```
dupscan [options] [directory]

  -m, --min-size <bytes>     ignore files smaller than this (default 1)
      --max-size <bytes>     ignore files larger than this
  -e, --exclude <pattern>    skip paths matching this regexp; repeatable
  -H, --hidden               include dotfiles and dot-directories
  -L, --follow               follow symbolic links
      --avg-chunk <bytes>    target average chunk size (default 65536)
      --limit <n>            report at most n groups
      --json                 machine-readable output
      --dry-run              report only, change nothing
```

Sizes accept suffixes: `1M`, `512k`, `2g`.

```sh
dupscan . --min-size 1M --exclude 'node_modules|\.git/'
dupscan . --json | jq -r '.groups[].files[].path'
```

## What it skips

Dotfiles and dot-directories unless `--hidden`, symbolic links unless
`--follow`, and anything matching `--exclude`. `node_modules`, `.git`,
`__pycache__` and friends are skipped by default, since scanning them is slow
and the results are never interesting.

## Known limits

- **Partial matching is capped at 8 same-sized files.** Past that, only exact
  duplicates are reported, because comparing every pair stops being cheap.
- **Coverage is chunk-quantised.** See above.
- **No hard links on different filesystems**, so a tree spanning mounts cannot
  be deduplicated in one pass.
- **Whole files are read into memory for chunking.** A single 4 GB file will
  not be handled. Streaming the hash instead is the obvious next step and is
  not implemented.
- Symlinks are compared by their target when `--follow` is on, so a symlink
  and its target will be reported as duplicates of each other.

## Development

```sh
git clone https://github.com/maybecooldev/dupscan
cd dupscan
npm test
```

44 tests, no dependencies.

## License

MIT
