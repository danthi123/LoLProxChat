// Decoder for the raw frame `capture_minimap` returns over the Tauri IPC.
//
// The wire format is defined once, in src-tauri/src/capture.rs, and the two
// halves are only correct together: a 4-byte little-endian width, a 4-byte
// little-endian height, then width * height * 4 bytes of top-down, row-major
// RGBA with no row padding.
//
// Deliberately free of any DOM type: this module is unit-tested under jest's
// 'node' environment, where ImageData does not exist.

export const CAPTURE_FRAME_HEADER_BYTES = 8;

/**
 * A decoded frame. Shaped so it can stand in for ImageData's read path, and
 * backed by a plain ArrayBuffer so it can also be handed to the ImageData
 * constructor where a real one is unavoidable (the classifier's canvas crop).
 */
export interface CaptureFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Parse a capture frame. `data` is a view onto `raw`, not a copy — the whole
 * point of the raw-bytes path is that a frame crosses the IPC and reaches the
 * CV without being re-encoded or re-allocated.
 *
 * Throws on anything it cannot parse; a frame whose header disagrees with its
 * own length means the two halves of the wire format have diverged, and
 * guessing which one is right would hand the CV a wrong row stride.
 */
export function decodeCaptureFrame(raw: ArrayBuffer | ArrayBufferView): CaptureFrame {
  let buffer: ArrayBuffer;
  let offset: number;
  let length: number;

  if (raw instanceof ArrayBuffer) {
    buffer = raw;
    offset = 0;
    length = raw.byteLength;
  } else if (ArrayBuffer.isView(raw)) {
    // A view's buffer is typed ArrayBufferLike; the IPC never hands back a
    // SharedArrayBuffer, and ImageData downstream will not accept one.
    buffer = raw.buffer as ArrayBuffer;
    offset = raw.byteOffset;
    length = raw.byteLength;
  } else {
    throw new Error('capture frame is not a buffer: ' + Object.prototype.toString.call(raw));
  }

  if (length < CAPTURE_FRAME_HEADER_BYTES) {
    throw new Error('capture frame is ' + length + ' bytes, shorter than its ' +
      CAPTURE_FRAME_HEADER_BYTES + '-byte header');
  }

  const header = new DataView(buffer, offset, CAPTURE_FRAME_HEADER_BYTES);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);

  if (width === 0 || height === 0) {
    throw new Error('capture frame header has a zero extent: ' + width + 'x' + height);
  }

  const pixelBytes = width * height * 4;
  const expected = CAPTURE_FRAME_HEADER_BYTES + pixelBytes;
  if (length !== expected) {
    throw new Error('capture frame is ' + length + ' bytes but its ' + width + 'x' + height +
      ' header needs ' + expected);
  }

  return {
    width,
    height,
    data: new Uint8ClampedArray(buffer, offset + CAPTURE_FRAME_HEADER_BYTES, pixelBytes),
  };
}
