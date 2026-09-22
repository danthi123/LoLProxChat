// Where TrackingService gets its pixels from.
//
// The tick loop and every CV stage below it are plain array work (see
// core/capture-frame.ts), so the Tauri `invoke` is the one thing in the scan
// path that cannot run outside the WebView. Naming it as a dependency is what
// lets tests/cv drive the real pipeline over synthesized frames with known
// ground truth instead of stubbing the detector out.
//
// Deliberately yields the raw wire bytes rather than a decoded frame: decoding,
// the header/bounds agreement check and the bounds resync all belong to the
// tracker, which is the half that knows what geometry it asked for.

import { invoke } from '@tauri-apps/api/core';

export interface FrameSource {
  /** One capture, framed exactly as src-tauri/src/capture.rs writes it. */
  capture(): Promise<ArrayBuffer>;
}

export class TauriFrameSource implements FrameSource {
  capture(): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>('capture_minimap');
  }
}
