// A TrackingService stand-in whose reported position is written by the test.
//
// The CV pipeline itself is covered in tests/cv, which drives the real
// TrackingService over synthesized frames. What this suite needs from a tracker
// is the ability to put a champion at an exact game coordinate, which no
// pixel-level harness can do without also proving the detector — and would then
// be testing two things at once.
//
// Three getters here gate the entire network path in positionTickInner: a
// SCANNING state short-circuits to a local ally-only 1.0, a (0,0) position
// returns early, and a hold above 2s stops reporting. A fake that defaulted to
// any of those would never reach the server, and every downstream failure would
// read as "wrong volume" rather than "no request was ever sent".

import { TrackingState } from '../../../src/services/tracking';
import { Position } from '../../../src/core/types';
import { ScreenRect } from '../../../src/core/map-calibration';

// Successive trackers start on different corners of the map, every pair of them
// further apart than the 1350-unit cross-team hearing range. A shared start
// coordinate put two champions on the same pixel until the first scripted move
// propagated, and a zero-distance exchange answers "ally at 1.0" and "enemy in
// range" on the ordinary distance rule alone — so assertions about the rules
// that are supposed to produce those answers held whether or not the rules
// existed. Consecutive entries are always distinct, which is what the two
// clients of a test need; the list is round-robined so a long run stays inside
// the map.
const START_POSITIONS: readonly Position[] = [
  { x: 1500, y: 1500 },
  { x: 13000, y: 13000 },
  { x: 1500, y: 13000 },
  { x: 13000, y: 1500 },
];
let startSeq = 0;

export class ScriptedTracker {
  state: TrackingState = TrackingState.LOCKED;
  position: Position | null = { ...START_POSITIONS[startSeq++ % START_POSITIONS.length] };
  cameraPosition: Position | null = null;
  holdSec = 0;
  cameraTrackingEnabled = false;
  started = false;
  stopped = false;
  deaths = 0;
  respawns = 0;
  classifierSet = false;
  appliedMinimapScale: number | null = null;

  private onPositionUpdate: ((pos: Position) => void) | null = null;
  private fps = 30;

  constructor(readonly gameRect: ScreenRect) {}

  readonly captureBounds = { x: 0, y: 0, width: 376, height: 376 };

  loadChampionTemplate(_championName: string): void { /* colour filter, nothing to load */ }
  async initCaptureBounds(): Promise<void> { /* no backend to tell */ }
  setClassifier(_c: unknown): void { this.classifierSet = true; }
  setMinimapScaleFromConfig(scale: number): void { this.appliedMinimapScale = scale; }
  setMinimapRegion(_r: unknown): void { /* calibration is not exercised here */ }

  start(onPositionUpdate: (pos: Position) => void, fps = 30): void {
    this.started = true;
    this.stopped = false;
    this.onPositionUpdate = onPositionUpdate;
    this.fps = fps;
  }
  stop(): void { this.stopped = true; this.onPositionUpdate = null; }

  getState(): TrackingState { return this.state; }
  getLastPosition(): Position | null { return this.position; }
  getHoldDurationSec(): number { return this.holdSec; }
  getCameraPosition(): Position | null {
    return this.cameraTrackingEnabled ? this.cameraPosition : null;
  }
  setCameraTracking(enabled: boolean): void {
    this.cameraTrackingEnabled = enabled;
    if (!enabled) this.cameraPosition = null;
  }
  /** A scripted camera position is either set or absent; when it is absent the
   *  reason is that the script said so, which is not one of the real detector's
   *  failure modes. */
  getCameraMiss(): null { return null; }
  getFilteredImageUrl(): string | null { return null; }
  getDetectedMinimapScreenBounds(): null { return null; }
  getScanFps(): number { return this.fps; }
  getGameRect(): ScreenRect { return this.gameRect; }
  onDeath(): void { this.deaths++; this.state = TrackingState.DEAD; }
  onRespawn(): void { this.respawns++; this.state = TrackingState.SCANNING; }

  /** Walk the champion to a new game coordinate. */
  moveTo(x: number, y: number): void {
    this.position = { x, y };
    this.onPositionUpdate?.(this.position);
  }

  /** Point the in-game camera somewhere, for the voice-on-camera path (#36). */
  lookAt(x: number, y: number): void {
    this.cameraPosition = { x, y };
  }
}
