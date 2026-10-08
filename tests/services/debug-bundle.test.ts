jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(async () => null) }));
let debugOn = true;
jest.mock('../../src/core/logging', () => ({ isLoggingEnabled: () => debugOn }));

import { invoke } from '@tauri-apps/api/core';
import { DebugBundle, bundleName, elapsedTag, ScoredCrop } from '../../src/services/debug-bundle';

const invokeMock = invoke as unknown as jest.Mock;

class FakeImageData {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}
class FakeOffscreenCanvas {
  constructor(readonly width: number, readonly height: number) {}
  getContext() { return { putImageData: () => undefined }; }
  async convertToBlob() { return { arrayBuffer: async () => new ArrayBuffer(4) }; }
}

beforeAll(() => {
  (globalThis as any).ImageData = FakeImageData;
  (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;
});

beforeEach(() => {
  invokeMock.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const files = () => invokeMock.mock.calls
  .filter((c) => c[0] === 'bundle_add_file')
  .map((c) => (c[2] as { headers: Record<string, string> }).headers['x-path']);
const frame = { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4) };
const region = { x: 5, y: 5, width: 10, height: 10 };

test('the zip is named after the lobby and when the game started', () => {
  expect(bundleName('vrb9uf', new Date(2026, 9, 7, 17, 5, 59))).toBe('vrb9uf_2026-10-07_17-05');
  expect(elapsedTag(187_400)).toBe('03-07.4');
  expect(elapsedTag(4_000)).toBe('00-04.0');
});

test('a minimap snapshot every 10 s, and one for each tracking event', async () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const bundle = (await DebugBundle.start('room1'))!;
  expect(invokeMock).toHaveBeenCalledWith('bundle_start', { name: expect.stringMatching(/^room1_\d{4}-\d\d-\d\d_\d\d-\d\d$/) });

  bundle.onFrame(frame, region);           // first frame: periodic
  now += 500; bundle.onFrame(frame, region); // nothing due
  now += 2000; bundle.markEvent('lock'); bundle.markEvent('lock'); bundle.onFrame(frame, region);
  now += 500; bundle.markEvent('lost'); bundle.markEvent('reacquired'); bundle.onFrame(frame, region); // under the 2 s gap: waits
  now += 1600; bundle.onFrame(frame, region); // now it goes, both tags
  now += 10_000; bundle.onFrame(frame, region);
  debugOn = false;
  now += 10_000; bundle.onFrame(frame, region); // Debug switched off: nothing
  debugOn = true;
  await flush();
  expect(files()).toEqual([
    'minimap/00-00.0_periodic.png',
    'minimap/00-02.5_lock.png',
    'minimap/00-04.6_lost-reacquired.png',
    'minimap/00-14.6_periodic.png',
  ]);
  // Every name passes the Rust side's [A-Za-z0-9._-] segments.
  for (const f of files()) expect(f.split('/').every((seg) => /^[A-Za-z0-9._-]+$/.test(seg))).toBe(true);
});

test('classifier crops every 5 s, named with where they were and how they scored', async () => {
  let now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const bundle = (await DebugBundle.start('room2'))!;
  const crop = (raw: number): ScoredCrop => ({
    image: new FakeImageData(new Uint8ClampedArray(4), 1, 1) as unknown as ImageData,
    cx: 12.4, cy: 40, raw, smoothed: 0.5,
  });
  bundle.onClassifierRun([crop(0.0123), crop(0)]);
  now += 1000; bundle.onClassifierRun([crop(0.5)]);
  now += 5000; bundle.onClassifierRun([crop(0.9)]);
  await flush();
  expect(files()).toEqual([
    'crops/00-00.0_0_at12x40_raw0.012_ema0.50.png',
    'crops/00-00.0_1_at12x40_raw0.000_ema0.50.png',
    'crops/00-06.0_0_at12x40_raw0.900_ema0.50.png',
  ]);
});
