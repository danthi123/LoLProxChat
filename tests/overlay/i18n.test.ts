import * as fs from 'fs';
import * as path from 'path';
import { allKeys, t, translateKey, translateStatus } from '../../src/overlay/i18n';
import { WARN_NOT_FOUND, WARN_IMPLAUSIBLE, WARN_QUERY_FAILED } from '../../src/core/game-window';
import { WARN_MINIMAP_TOO_LARGE, WARN_CALIBRATION_OUTSIDE_CAPTURE } from '../../src/services/tracking';
import { STATUS_MIC_BLOCKED } from '../../src/services/orchestrator';

const root = path.join(__dirname, '../..');

describe('panel strings', () => {
  test('every string has a non-empty English and Spanish version with the same placeholders', () => {
    for (const key of allKeys()) {
      const en = t(key, {}, 'en');
      const es = t(key, {}, 'es');
      expect(en.length).toBeGreaterThan(0);
      expect(es.length).toBeGreaterThan(0);
      const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(holes(es)).toEqual(holes(en));
    }
  });

  test('placeholders are filled', () => {
    expect(t('update.upToDate', { version: '0.5.14' }, 'es')).toBe('Ya tienes la última versión (v0.5.14)');
  });

  test('every key the HTML references exists', () => {
    const html = fs.readFileSync(path.join(root, 'src/overlay/overlay.html'), 'utf8');
    const keys = new Set<string>(allKeys());
    const used = [...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(20);
    for (const k of used) expect(keys.has(k)).toBe(true);
  });

  test('the overlay script has no hard-coded English labels left', () => {
    const src = fs.readFileSync(path.join(root, 'src/overlay/overlay.ts'), 'utf8');
    for (const label of ["'ON'", "'OFF'", "'MUTE'", "'MUTED'", "'DEAD'", "'RESET'", "'SEARCHING'", "'Default'", "'(unbound)'"]) {
      expect(src).not.toContain(label);
    }
  });
});

describe('status lines from the services', () => {
  // Every literal the orchestrator can put on the panel, read from its source
  // so that a new status line added in English fails here until translated.
  function orchestratorStatuses(): string[] {
    const src = fs.readFileSync(path.join(root, 'src/services/orchestrator.ts'), 'utf8');
    const out: string[] = [];
    for (const fn of ['computeLifecycleStatus(): string {', 'sessionFailureText(reason: SessionFailureReason): string {']) {
      const start = src.indexOf(fn);
      expect(start).toBeGreaterThan(0);
      const body = src.slice(start, src.indexOf('\n  }\n', start));
      for (const m of body.matchAll(/return\s+(['"])(.+?)\1;/g)) out.push(m[2]);
    }
    return out;
  }

  test('every one is translated to Spanish', () => {
    const lines = [
      ...orchestratorStatuses(),
      WARN_NOT_FOUND, WARN_IMPLAUSIBLE, WARN_QUERY_FAILED,
      WARN_MINIMAP_TOO_LARGE, WARN_CALIBRATION_OUTSIDE_CAPTURE, STATUS_MIC_BLOCKED,
    ];
    expect(lines.length).toBeGreaterThan(15);
    for (const line of lines) {
      const es = translateStatus(line, 'es');
      expect(es).not.toBe(line);
      expect(es.length).toBeGreaterThan(0);
    }
  });

  test('the unsupported-map line keeps the mode name', () => {
    const src = fs.readFileSync(path.join(root, 'src/services/game-state.ts'), 'utf8');
    expect(src).toContain("'Proximity is off — ' + gameMode + ' is not a supported map'");
    expect(translateStatus('Proximity is off — ARAM is not a supported map', 'es'))
      .toBe('Proximidad desactivada — ARAM no es un mapa compatible');
  });

  test('English and empty lines pass through unchanged', () => {
    expect(translateStatus('In lobby', 'en')).toBe('In lobby');
    expect(translateStatus('', 'es')).toBe('');
    expect(translateStatus('SomeFuturePhase', 'es')).toBe('SomeFuturePhase');
  });
});

describe('key names', () => {
  test('use Spanish keyboard names', () => {
    expect(translateKey('Caps Lock', 'es')).toBe('Bloq Mayús');
    expect(translateKey('Caps Lock', 'en')).toBe('Caps Lock');
    expect(translateKey('F5', 'es')).toBe('F5');
  });
});
