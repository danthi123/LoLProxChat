import { invoke } from '@tauri-apps/api/core';
import { CAPTURE_FRAME_HEADER_BYTES, decodeCaptureFrame } from '../../src/core/capture-frame';
import { TrackingService } from '../../src/services/tracking';

jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>;

/**
 * Build a frame the way src-tauri/src/capture.rs writes one: little-endian
 * width and height, then top-down row-major RGBA.
 */
function makeFrame(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number] = () => [0, 0, 0],
): ArrayBuffer {
  const buf = new ArrayBuffer(CAPTURE_FRAME_HEADER_BYTES + width * height * 4);
  const header = new DataView(buf, 0, CAPTURE_FRAME_HEADER_BYTES);
  header.setUint32(0, width, true);
  header.setUint32(4, height, true);
  const px = new Uint8Array(buf, CAPTURE_FRAME_HEADER_BYTES);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return buf;
}

describe('decodeCaptureFrame', () => {
  test('reads the little-endian width/height header', () => {
    const frame = decodeCaptureFrame(makeFrame(3, 2));
    expect(frame.width).toBe(3);
    expect(frame.height).toBe(2);
    expect(frame.data.length).toBe(3 * 2 * 4);
  });

  // The decoder reorders nothing — this documents the layout both halves of
  // the wire format must agree on, so a change to either one has to come here
  // first. src-tauri/src/capture.rs is the writer.
  test('documents the top-down row-major layout: pixel (x,y) is at ((y*w)+x)*4', () => {
    const frame = decodeCaptureFrame(makeFrame(3, 2, (x, y) => [x, y, 0]));
    expect([frame.data[0], frame.data[1]]).toEqual([0, 0]);
    const idx = (1 * 3 + 2) * 4;
    expect([frame.data[idx], frame.data[idx + 1]]).toEqual([2, 1]);
  });

  // Performance guard, not a correctness invariant: the raw path exists so a
  // frame reaches the CV without being re-encoded or re-allocated. Delete this
  // if a consumer is ever found that forces a copy.
  test('views the input buffer rather than copying it', () => {
    const raw = makeFrame(3, 2);
    const frame = decodeCaptureFrame(raw);
    expect(frame.data.buffer).toBe(raw);
    expect(frame.data.byteOffset).toBe(CAPTURE_FRAME_HEADER_BYTES);
  });

  test('decodes a view with a non-zero byteOffset identically', () => {
    const raw = makeFrame(3, 2, (x, y) => [x, y, 0]);
    const padded = new Uint8Array(16 + raw.byteLength);
    padded.set(new Uint8Array(raw), 16);
    const view = new Uint8Array(padded.buffer, 16, raw.byteLength);

    const frame = decodeCaptureFrame(view);
    expect([frame.width, frame.height]).toEqual([3, 2]);
    const idx = (1 * 3 + 2) * 4;
    expect([frame.data[idx], frame.data[idx + 1]]).toEqual([2, 1]);
  });

  test('rejects a buffer shorter than the header', () => {
    expect(() => decodeCaptureFrame(new ArrayBuffer(4))).toThrow(/shorter than/);
  });

  test('rejects a zero extent', () => {
    expect(() => decodeCaptureFrame(makeFrame(0, 0))).toThrow(/zero extent/);
  });

  test('rejects a payload that disagrees with its own header', () => {
    const raw = makeFrame(3, 3);
    const header = new DataView(raw, 0, CAPTURE_FRAME_HEADER_BYTES);
    header.setUint32(0, 4, true);
    header.setUint32(4, 4, true);
    expect(() => decodeCaptureFrame(raw)).toThrow(/header needs/);
  });

  test('rejects something that is not a buffer', () => {
    expect(() => decodeCaptureFrame({ width: 3 } as unknown as ArrayBuffer)).toThrow(/not a buffer/);
  });

  // Ties the wire format to the 378px capture square that
  // tests/core/map-calibration.test.ts pins for a 1080p game window.
  test('parses a full-size 1080p frame', () => {
    const raw = makeFrame(378, 378);
    expect(raw.byteLength).toBe(571544);
    const frame = decodeCaptureFrame(raw);
    expect([frame.width, frame.height]).toEqual([378, 378]);
  });
});

/**
 * The wire format's other half: TrackingService.tick() consuming what
 * capture_minimap returns. Drives the real tick, not a stand-in for it.
 */
describe('TrackingService.tick over the capture frame wire format', () => {
  /** A borderless 1080p game window on the primary monitor — capture is 378x378. */
  const FULL_HD = { x: 0, y: 0, width: 1920, height: 1080 };

  let errors: unknown[][];
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockInvoke.mockReset();
    errors = [];
    errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  /** Let the invoke promise and its handlers settle. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function newService(): TrackingService {
    return new TrackingService(FULL_HD, 'summoners_rift');
  }

  test('a well-formed frame runs the CV pass and releases the tick guard', async () => {
    const svc = newService();
    svc.setMinimapRegion({ x: 0, y: 0, width: 100, height: 100 });
    mockInvoke.mockResolvedValue(makeFrame(378, 378));

    (svc as unknown as { tick(): void }).tick();
    await settle();

    expect(errors).toEqual([]);
    expect((svc as unknown as { tickRunning: boolean }).tickRunning).toBe(false);
    // Bumped once per frame that made it past the mask/blob passes.
    expect((svc as unknown as { diagCounter: number }).diagCounter).toBe(1);
    // Debug is off (no `window` here), so no PNG was encoded.
    expect(svc.getFilteredImageUrl()).toBeNull();
  });

  test('a failed capture is reported under its own message and releases the guard', async () => {
    const svc = newService();
    mockInvoke.mockRejectedValue('Capture bounds not set. Call set_capture_bounds first.');

    (svc as unknown as { tick(): void }).tick();
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('[Tracking] capture_minimap failed:');
    expect((svc as unknown as { tickRunning: boolean }).tickRunning).toBe(false);
  });

  test('a self-consistent frame of the wrong size is refused, not indexed', async () => {
    const svc = newService();
    svc.setMinimapRegion({ x: 0, y: 0, width: 100, height: 100 });
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'capture_minimap' ? Promise.resolve(makeFrame(377, 377)) : Promise.resolve(undefined),
    );

    (svc as unknown as { tick(): void }).tick();
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('[Tracking] frame decode failed:');
    expect(String(errors[0][1])).toContain('377x377');
    // Nothing was indexed against the mismatched frame.
    expect((svc as unknown as { diagCounter: number }).diagCounter).toBe(0);
    // ...and the bounds were re-pushed once, as the only recovery available.
    expect(mockInvoke).toHaveBeenCalledWith('set_capture_bounds', expect.anything());
    expect((svc as unknown as { tickRunning: boolean }).tickRunning).toBe(false);
  });

  test('the bounds resync fires once per distinct bad frame size', async () => {
    const svc = newService();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'capture_minimap' ? Promise.resolve(makeFrame(377, 377)) : Promise.resolve(undefined),
    );

    for (let i = 0; i < 3; i++) {
      (svc as unknown as { tick(): void }).tick();
      await settle();
    }

    const resyncs = mockInvoke.mock.calls.filter((c) => c[0] === 'set_capture_bounds');
    expect(resyncs).toHaveLength(1);
    // And the per-tick throw is logged once, not three times.
    expect(errors).toHaveLength(1);
  });
});
