#!/usr/bin/env node
/**
 * Bumps the project version and updates the changelog in one shot:
 *   - src-tauri/Cargo.toml   (the [package] version)
 *   - src-tauri/Cargo.lock   (the lolproxchat package entry)
 *   - CHANGELOG.md           (new dated section holding whatever was under
 *                             [Unreleased] plus --changelog, merged by heading;
 *                             footnote link; [Unreleased] compare link)
 *
 * Used by icon-watch.yml to turn a retrain into a release-ready PR (merging it
 * triggers release.yml via the version bump), and usable by hand for manual
 * releases. Prints the new version to stdout (nothing else on stdout).
 *
 * Run: node scripts/bump-version.mjs [--type patch|minor|major] \
 *        [--changelog "### Changed\n- ..."] [--date YYYY-MM-DD]
 *
 * Line-ending tolerant (\r?\n) so it works on a Windows checkout and on Linux CI.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'danthi123/LoLProxChat';
const CARGO_TOML = 'src-tauri/Cargo.toml';
const CARGO_LOCK = 'src-tauri/Cargo.lock';
const CHANGELOG = 'CHANGELOG.md';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const type = arg('--type', 'patch');
const body = arg('--changelog', '### Changed\n- _Describe the change._').replace(/\\n/g, '\n');
const date = arg('--date', new Date().toISOString().slice(0, 10));

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// --- current version from Cargo.toml ([package] version, the only line-start `version =`) ---
const toml = readFileSync(CARGO_TOML, 'utf8');
const m = toml.match(/^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"/m);
if (!m) fail(`Could not find a version in ${CARGO_TOML}`);
let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
const oldVersion = `${maj}.${min}.${pat}`;
if (type === 'major') (maj++, (min = 0), (pat = 0));
else if (type === 'minor') (min++, (pat = 0));
else pat++;
const version = `${maj}.${min}.${pat}`;
const tag = `v${version}`;

// --- Cargo.toml: replace the package version line ---
writeFileSync(CARGO_TOML, toml.replace(/^version\s*=\s*"\d+\.\d+\.\d+"/m, `version = "${version}"`));

// --- Cargo.lock: replace the version inside the lolproxchat block ---
const lock = readFileSync(CARGO_LOCK, 'utf8');
const lockRe = /(name = "lolproxchat"\r?\nversion = )"\d+\.\d+\.\d+"/;
if (!lockRe.test(lock)) fail(`Could not find the lolproxchat entry in ${CARGO_LOCK}`);
writeFileSync(CARGO_LOCK, lock.replace(lockRe, `$1"${version}"`));

// --- CHANGELOG.md: new section under [Unreleased] + footnote links ---
// Anything already under [Unreleased] belongs to this release too, so it moves
// into the new section, merged heading by heading. Inserting the new section
// above it instead (as this used to) left that content stranded under the new
// version with a second "### Changed" — or, when [Unreleased] held a heading
// the new body lacked, under no version at all.
const raw = readFileSync(CHANGELOG, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let cl = raw.replace(/\r\n/g, '\n');
if (cl.includes(`## [${tag}]`)) fail(`${CHANGELOG} already has a ${tag} section`);

// Keep a Changelog's heading order; any other heading follows, as first seen.
const ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/** Split markdown into the text before its first `### ` and its `### ` sections. */
function parseSections(text) {
  const pre = [];
  const secs = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^### (.+?)\s*$/);
    if (h) secs.push((cur = { title: h[1], lines: [] }));
    else (cur ? cur.lines : pre).push(line);
  }
  return { pre: pre.join('\n').trim(), secs };
}

/** Merge sections of the same heading, first-seen content first. */
function mergeSections(...blocks) {
  const pre = blocks.map((b) => b.pre).filter(Boolean);
  const byTitle = new Map();
  for (const b of blocks) {
    for (const s of b.secs) {
      const text = s.lines.join('\n').trim();
      if (!byTitle.has(s.title)) byTitle.set(s.title, []);
      if (text) byTitle.get(s.title).push(text);
    }
  }
  const rank = (t) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length);
  const titles = [...byTitle.keys()].sort((a, b) => rank(a) - rank(b)); // stable
  const parts = [...pre, ...titles.map((t) => `### ${t}\n${byTitle.get(t).join('\n')}`)];
  return parts.join('\n\n');
}

// [Unreleased]'s content runs to the next version heading or the link footnotes.
const unreleasedRe = /(## \[Unreleased\]\n)([\s\S]*?)(?=\n## \[|\n\[[^\]\n]+\]: |$)/;
const um = cl.match(unreleasedRe);
const pending = um ? parseSections(um[2]) : { pre: '', secs: [] };
const section = `## [${tag}] — ${date}\n\n${mergeSections(pending, parseSections(body))}\n`;
if (um) {
  cl = cl.replace(unreleasedRe, (_, head) => `${head}\n${section}`);
} else {
  cl = cl.replace(/(\n## \[v)/, `\n${section}\n## [v`);
}

const footnote = `[${tag}]: https://github.com/${REPO}/releases/tag/${tag}`;
if (/^\[v\d+\.\d+\.\d+\]: /m.test(cl)) {
  cl = cl.replace(/^(\[v\d+\.\d+\.\d+\]: )/m, `${footnote}\n$1`);
} else {
  cl = `${cl.trimEnd()}\n\n${footnote}\n`;
}
// The [Unreleased] link compares against the newest release.
cl = cl.replace(/^(\[Unreleased\]: \S+\/compare\/)\S+?(\.\.\.HEAD)$/m, `$1${tag}$2`);
writeFileSync(CHANGELOG, cl.replace(/\n/g, eol));

console.error(`Bumped ${oldVersion} -> ${version} (${type}); CHANGELOG dated ${date}`);
process.stdout.write(`${version}\n`);
