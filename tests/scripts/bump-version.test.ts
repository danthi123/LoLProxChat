/**
 * scripts/bump-version.mjs, run for real against a throwaway copy of the three
 * files it edits. icon-watch.yml runs it unattended, so a CHANGELOG it mangles
 * goes straight into a release PR (v0.5.25's did: a second "### Changed").
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/bump-version.mjs');

const TOML = '[package]\nname = "lolproxchat"\nversion = "0.5.25"\n';
const LOCK = '[[package]]\nname = "lolproxchat"\nversion = "0.5.25"\n';
const HEAD = '# Changelog\n\nIntro.\n\n## [Unreleased]\n';
const TAIL =
  '## [v0.5.25] — 2026-11-18\n\n### Changed\n- Old.\n\n' +
  '[Unreleased]: https://github.com/danthi123/LoLProxChat/compare/v0.5.25...HEAD\n' +
  '[v0.5.25]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.25\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bump-'));
  mkdirSync(join(dir, 'src-tauri'));
  writeFileSync(join(dir, 'src-tauri/Cargo.toml'), TOML);
  writeFileSync(join(dir, 'src-tauri/Cargo.lock'), LOCK);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bump(changelog: string, body = '### Changed\\n- Retrained.'): { out: string; cl: string } {
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  const out = execFileSync(process.execPath, [SCRIPT, '--changelog', body, '--date', '2026-12-01'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { out, cl: readFileSync(join(dir, 'CHANGELOG.md'), 'utf8') };
}

test('bumps the version in Cargo.toml and Cargo.lock and prints only the version', () => {
  const { out } = bump(HEAD + '\n' + TAIL);
  expect(out).toBe('0.5.26\n');
  expect(readFileSync(join(dir, 'src-tauri/Cargo.toml'), 'utf8')).toContain('version = "0.5.26"');
  expect(readFileSync(join(dir, 'src-tauri/Cargo.lock'), 'utf8')).toContain('version = "0.5.26"');
});

test('with nothing unreleased, the new section is just the body', () => {
  const { cl } = bump(HEAD + '\n' + TAIL);
  expect(cl).toContain('## [Unreleased]\n\n## [v0.5.26] — 2026-12-01\n\n### Changed\n- Retrained.\n\n## [v0.5.25]');
});

test('moves pending [Unreleased] entries into the new section, one heading each', () => {
  const pending = '\n### Fixed\n- A fix.\n\n### Changed\n- Hand-written change.\n\n';
  const { cl } = bump(HEAD + pending + TAIL);
  expect(cl).toContain(
    '## [Unreleased]\n\n## [v0.5.26] — 2026-12-01\n\n' +
      '### Changed\n- Hand-written change.\n- Retrained.\n\n' +
      '### Fixed\n- A fix.\n\n## [v0.5.25]',
  );
  const newSection = cl.slice(cl.indexOf('## [v0.5.26]'), cl.indexOf('## [v0.5.25]'));
  expect(newSection.match(/### Changed/g)).toHaveLength(1);
});

test('keeps unknown headings and text before the first heading', () => {
  const pending = '\nSome note.\n\n### Notes\n- Odd heading.\n\n### Added\n- Thing.\n\n';
  const { cl } = bump(HEAD + pending + TAIL);
  expect(cl).toContain(
    '## [v0.5.26] — 2026-12-01\n\nSome note.\n\n### Added\n- Thing.\n\n### Changed\n- Retrained.\n\n### Notes\n- Odd heading.\n\n## [v0.5.25]',
  );
});

test('adds the release link and moves the [Unreleased] compare link to the new tag', () => {
  const { cl } = bump(HEAD + '\n' + TAIL);
  expect(cl).toContain('[Unreleased]: https://github.com/danthi123/LoLProxChat/compare/v0.5.26...HEAD');
  expect(cl).toContain(
    '[v0.5.26]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.26\n' +
      '[v0.5.25]: https://github.com/danthi123/LoLProxChat/releases/tag/v0.5.25',
  );
});

test('keeps CRLF line endings on a Windows checkout', () => {
  const { cl } = bump((HEAD + '\n### Fixed\n- A fix.\n\n' + TAIL).replace(/\n/g, '\r\n'));
  expect(cl).toContain('### Fixed\r\n- A fix.');
  expect(cl.replace(/\r\n/g, '')).not.toContain('\n');
});
