import { setLoggingEnabled } from '../core/logging';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  checkForUpdate,
  downloadAndApply,
  isAutoUpdateEnabled,
  setAutoUpdateEnabled,
} from '../services/updater';
import {
  getStoredInputDeviceId,
  setStoredInputDeviceId,
  getStoredOutputDeviceId,
  setStoredOutputDeviceId,
  listAudioDevices,
  probeMicPermission,
} from '../services/devices';
import { getForceTurnRelay, setForceTurnRelay } from '../services/privacy';
import { getAllyProximity, setAllyProximity, getCameraListen, setCameraListen } from '../services/audio-prefs';
import { computeDesiredHeight, shouldSendSize } from './resize-helpers';
import { browserKeyToWin32Vk, humanizeVk } from '../core/keymap';
import {
  LANGUAGES, Lang, StringKey, applyTranslations, getLanguage, setLanguage, t, translateKey, translateStatus,
} from './i18n';
import '../core/window-globals';

// v0.3 (#11): dynamic overlay-window resize so the panel grows to fit
// debug-thumbnail / settings content and shrinks back when they collapse.
// requestAnimationFrame-batched so we don't ping Rust at full frame rate
// when ResizeObserver fires rapidly (image load, etc).
let resizeQueued = false;
// Last height actually sent to Rust. The rAF guard below only coalesces within
// a single frame; without this, a panel DOM rewrite every scan tick produced a
// window resize every frame for the whole match (see shouldSendSize).
let lastSentOverlayHeight: number | null = null;
function syncOverlayHeight(): void {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const panel = document.querySelector('.panel') as HTMLElement | null;
    if (!panel) return;
    // scrollHeight is in logical CSS px; the Rust side sizes the window in
    // PHYSICAL px (and so does the click-through hit-rect, which is compared
    // against physical Win32 cursor coords). Multiply by devicePixelRatio so
    // the window fits its content on scaled displays — without this a 125/150%
    // laptop got a too-short window and clipped the debug thumbnail, while a
    // 100% ultrawide looked fine. Matches the panelResize convention below.
    const dpr = window.devicePixelRatio || 1;
    const desired = computeDesiredHeight(Math.ceil(panel.scrollHeight));
    const height = Math.round(desired * dpr);
    if (!shouldSendSize(lastSentOverlayHeight, height)) return;
    lastSentOverlayHeight = height;
    sendToBackground('resizeOverlay', { height });
  });
}

interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isMuted: boolean;
  isMutedByLocal: boolean;
  isDead: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
  trackingState?: string;
  lastPosition?: { x: number; y: number } | null;
  filteredImageUrl?: string | null;
  detectedMinimapBounds?: { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null;
  localTeam?: 'ORDER' | 'CHAOS' | null;
  lifecycleStatus?: string;
}

const playerList = document.getElementById('player-list')!;
const btnSelfMute = document.getElementById('btn-self-mute')!;
const btnMuteAll = document.getElementById('btn-mute-all')!;
const btnSettings = document.getElementById('btn-settings')!;
const btnDebug = document.getElementById('btn-debug')!;
const btnCollapse = document.getElementById('btn-collapse')!;
const panel = document.getElementById('panel')!;
const settingsPanel = document.getElementById('settings-panel')!;
const dragHandle = document.getElementById('drag-handle')!;

// Debug overlay state — always starts off; user toggles per session.
let debugEnabled = false;
setLoggingEnabled(false);

// Every toggle shows ON/OFF in the panel language.
const onOff = (on: boolean): string => t(on ? 'settings.on' : 'settings.off');

// Per-player volume cache (so sliders don't reset on re-render)
const playerVolumes: Map<string, number> = new Map();

// Tauri handles window dragging and resizing via its window config.
// The drag handle uses Tauri's built-in data-tauri-drag-region attribute
// (set in the HTML). No manual drag/resize logic needed.

// --- Controls ---
// MIC / VOL buttons signal their muted state via the `.active` color only —
// the label stays "MIC" / "VOL" (no "OFF" suffix) so the button width doesn't
// jump and the icon-button row stays visually stable.
btnSelfMute.addEventListener('click', () => {
  const nowMuted = !btnSelfMute.classList.contains('active');
  btnSelfMute.classList.toggle('active', nowMuted);
  sendToBackground('toggleSelfMute', {});
});

btnMuteAll.addEventListener('click', () => {
  const nowMuted = !btnMuteAll.classList.contains('active');
  btnMuteAll.classList.toggle('active', nowMuted);
  sendToBackground('toggleMuteAll', {});
});

// "Wrong position?": the header's POS button (always in reach, collapsed or
// not) and the labelled RESET row in Settings do the same thing. Both light up
// for 2s so a click mid-game visibly registered.
const btnResetPosition = document.getElementById('btn-reset-position')!;
const btnResetHeader = document.getElementById('btn-reset-header')!;
let resetFeedbackId: ReturnType<typeof setTimeout> | null = null;
function resetPosition(): void {
  sendToBackground('resetPosition', {});
  btnResetPosition.textContent = t('settings.searching');
  btnResetHeader.classList.add('searching');
  if (resetFeedbackId !== null) clearTimeout(resetFeedbackId);
  resetFeedbackId = setTimeout(() => {
    btnResetPosition.textContent = t('settings.reset');
    btnResetHeader.classList.remove('searching');
    resetFeedbackId = null;
  }, 2000);
}
btnResetPosition.addEventListener('click', resetPosition);
btnResetHeader.addEventListener('click', resetPosition);

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    refreshDeviceLists();
  }
  syncOverlayHeight();
});

// --- Audio device pickers ---
const inputDeviceSelect = document.getElementById('input-device') as HTMLSelectElement;
const outputDeviceSelect = document.getElementById('output-device') as HTMLSelectElement;

async function refreshDeviceLists(): Promise<void> {
  try {
    let { inputs, outputs } = await listAudioDevices();
    // Empty labels mean the user hasn't granted mic permission yet. Trigger
    // a one-shot probe so labels populate; then re-enumerate.
    if (inputs.some((d) => !d.label) || outputs.some((d) => !d.label)) {
      try {
        await probeMicPermission();
        ({ inputs, outputs } = await listAudioDevices());
      } catch {
        // User denied or no mic present — fall through with whatever labels we have
      }
    }
    populateDeviceSelect(inputDeviceSelect, inputs, getStoredInputDeviceId());
    populateDeviceSelect(outputDeviceSelect, outputs, getStoredOutputDeviceId());
  } catch (e) {
    console.warn('[Overlay] device enumeration failed:', e);
  }
}

function populateDeviceSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  selectedId: string | null,
): void {
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = t('settings.default');
  const opts: HTMLOptionElement[] = [defaultOpt];
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || t(d.kind === 'audiooutput' ? 'settings.unnamedOutput' : 'settings.unnamedInput');
    opts.push(opt);
  }
  select.replaceChildren(...opts);
  select.value = selectedId && devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
}

inputDeviceSelect.addEventListener('change', () => {
  const id = inputDeviceSelect.value || null;
  setStoredInputDeviceId(id);
  sendToBackground('setInputDevice', { id });
});

outputDeviceSelect.addEventListener('change', () => {
  const id = outputDeviceSelect.value || null;
  setStoredOutputDeviceId(id);
  sendToBackground('setOutputDevice', { id });
});

// Refresh if user plugs / unplugs a device while the panel is open
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!settingsPanel.classList.contains('hidden')) {
    refreshDeviceLists();
  }
});

let collapsed = false;
btnCollapse.addEventListener('click', () => {
  collapsed = !collapsed;
  panel.classList.toggle('collapsed', collapsed);
  btnCollapse.textContent = collapsed ? '\u00AB' : '\u00BB';
  btnCollapse.title = t(collapsed ? 'header.expand' : 'header.collapse');
  // Close settings when collapsing
  if (collapsed) {
    settingsPanel.classList.add('hidden');
  }
});

const scanRateRow = document.getElementById('scan-rate-row')!;
const btnAutoUpdate = document.getElementById('btn-autoupdate') as HTMLButtonElement;
const btnCheckUpdate = document.getElementById('btn-check-update') as HTMLButtonElement;
const updateStatus = document.getElementById('update-status')!;

// --- Auto-update UI ---
function syncAutoUpdateButton(): void {
  const on = isAutoUpdateEnabled();
  btnAutoUpdate.textContent = onOff(on);
  btnAutoUpdate.classList.toggle('active', on);
}
queueMicrotask(syncAutoUpdateButton);

btnAutoUpdate.addEventListener('click', () => {
  setAutoUpdateEnabled(!isAutoUpdateEnabled());
  syncAutoUpdateButton();
});

// Kept as a key so a language switch re-renders the line instead of wiping it.
let updateStatusMsg: { key: StringKey; params: Record<string, string> } | null = null;
function setUpdateStatus(key: StringKey | null, params: Record<string, string> = {}): void {
  updateStatusMsg = key ? { key, params } : null;
  updateStatus.textContent = key ? t(key, params) : '';
}

async function runUpdateCheck(triggeredByUser: boolean): Promise<void> {
  setUpdateStatus('update.checking');
  try {
    const info = await checkForUpdate();
    if (info.update_available && info.download_url) {
      setUpdateStatus('update.available', { version: String(info.latest_version) });
      await downloadAndApply(info.download_url);
      // If apply succeeds, the process exits before we reach here
    } else {
      if (triggeredByUser) setUpdateStatus('update.upToDate', { version: String(info.current_version) });
      else setUpdateStatus(null);
    }
  } catch (e) {
    setUpdateStatus('update.failed', { error: (e as Error).message });
  }
}

btnCheckUpdate.addEventListener('click', () => {
  runUpdateCheck(true);
});

const btnOpenLogs = document.getElementById('btn-open-logs') as HTMLButtonElement;
btnOpenLogs.addEventListener('click', () => {
  sendToBackground('openLogFolder', {});
});

// Expose for background.ts to trigger an auto-check on launch
window.__proxchatRunUpdateCheck = runUpdateCheck;

// Force-TURN privacy toggle. New peer connections created after this is
// flipped honor the new setting; existing connections keep whatever policy
// they were created with (would need to re-join the game to apply).
const btnForceTurn = document.getElementById('btn-force-turn') as HTMLButtonElement;
function syncForceTurnButton(): void {
  const on = getForceTurnRelay();
  btnForceTurn.textContent = onOff(on);
  btnForceTurn.classList.toggle('active', on);
}
queueMicrotask(syncForceTurnButton);
btnForceTurn.addEventListener('click', () => {
  setForceTurnRelay(!getForceTurnRelay());
  syncForceTurnButton();
});

// Ally-proximity toggle (#22). When ON, teammates fade with distance (the same
// falloff as enemies) instead of always playing at full volume. The orchestrator
// reads this fresh on each /compute-volumes tick, so flipping it takes effect on
// the next position update — no reconnect needed.
const btnAllyProximity = document.getElementById('btn-ally-proximity') as HTMLButtonElement;
function syncAllyProximityButton(): void {
  const on = getAllyProximity();
  btnAllyProximity.textContent = onOff(on);
  btnAllyProximity.classList.toggle('active', on);
}
queueMicrotask(syncAllyProximityButton);
btnAllyProximity.addEventListener('click', () => {
  setAllyProximity(!getAllyProximity());
  syncAllyProximityButton();
});

// Voice-on-camera toggle (#36). When ON, the orchestrator sends the minimap
// camera-rectangle centre as the point we hear from, so panning the camera moves
// your ears without moving your champion. Read fresh on each /compute-volumes
// tick, so flipping it takes effect on the next position update.
const btnCameraListen = document.getElementById('btn-camera-listen') as HTMLButtonElement;
function syncCameraListenButton(): void {
  const on = getCameraListen();
  btnCameraListen.textContent = onOff(on);
  btnCameraListen.classList.toggle('active', on);
}
queueMicrotask(syncCameraListenButton);
btnCameraListen.addEventListener('click', () => {
  setCameraListen(!getCameraListen());
  syncCameraListenButton();
});

// v0.3 (#1): PTT + toggle-mute key rebind. The Rust WH_KEYBOARD_LL hook
// reads the bound VK code from atomics it exposes via set_ptt_key /
// set_toggle_key Tauri commands. UI pattern: click the button → "Press a
// key..." prompt → capture next keydown → translate to Win32 VK → persist
// + push to Rust.
const PTT_VK_KEY = 'lolproxchat.pttVk';
const TOGGLE_VK_KEY = 'lolproxchat.toggleVk';
// The key left of 1 on this keyboard layout (º on Spanish, ` on US), asked of
// Rust at startup. Until v0.5.16 this was Caps Lock, whose toggle the hook has
// to cancel on every press — which left testers unable to type capitals. A
// stored bind, Caps Lock included, is kept. VK_OEM_3 until Rust answers.
let DEFAULT_PTT_VK: number | null = 0xC0;
const FORBIDDEN_CODES = new Set([
  'Escape', 'Tab',
  // Common LoL bindings — would conflict with gameplay even though our
  // hook fires first.
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyD', 'KeyF', 'KeyB', 'KeyP',
  // Modifier-only is bad UX (always pressed during typing combos)
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

// Re-label the bind buttons when the language changes (key names are
// localized too: Caps Lock is Bloq Mayús on a Spanish keyboard).
const bindRelabelers: Array<() => void> = [];

/** Layout names for the OEM punctuation keys, whose US names mislead on
 *  other layouts (VK_OEM_5 is "\\" on US and "º" on Spanish). */
const layoutKeyNames = new Map<number, string>();
function keyLabel(vk: number): string {
  return layoutKeyNames.get(vk) ?? translateKey(humanizeVk(vk));
}
async function learnKeyName(vk: number): Promise<void> {
  if (vk < 0xBA || layoutKeyNames.has(vk)) return;
  try {
    const name = await invoke<string | null>('key_name', { vk });
    if (name) {
      layoutKeyNames.set(vk, name);
      bindRelabelers.forEach((f) => f());
    }
  } catch { /* the US name stays */ }
}

function setupBindButton(buttonId: string, storageKey: string, backgroundCmd: string, defaultVk: number | null): void {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  if (!btn) return;
  const stored = localStorage.getItem(storageKey);
  let boundVk = stored !== null ? parseInt(stored, 10) : defaultVk;
  if (boundVk) void learnKeyName(boundVk);
  const label = (): string =>
    boundVk !== null && !Number.isNaN(boundVk) && boundVk > 0 ? keyLabel(boundVk) : t('settings.unbound');
  btn.textContent = label();
  // Mid-capture the button shows the prompt (or a 1.5s rejection, which then
  // restores label() in whatever language is current by then).
  bindRelabelers.push(() => { btn.textContent = btn.disabled ? t('settings.pressKey') : label(); });

  btn.addEventListener('click', () => {
    btn.textContent = t('settings.pressKey');
    btn.classList.add('active');
    btn.disabled = true;
    const restore = (text: string) => {
      btn.textContent = text;
      btn.classList.remove('active');
      btn.disabled = false;
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onKey, true);
      if (e.code === 'Escape') {
        restore(label());
        return;
      }
      if (FORBIDDEN_CODES.has(e.code)) {
        restore(t('settings.forbiddenKey'));
        setTimeout(() => restore(label()), 1500);
        return;
      }
      const vk = browserKeyToWin32Vk(e.code);
      if (vk === null) {
        restore(t('settings.unsupportedKey'));
        setTimeout(() => restore(label()), 1500);
        return;
      }
      localStorage.setItem(storageKey, String(vk));
      sendToBackground(backgroundCmd, { vk });
      boundVk = vk;
      void learnKeyName(vk);
      restore(label());
    };
    window.addEventListener('keydown', onKey, true);
  });
}

queueMicrotask(async () => {
  try {
    DEFAULT_PTT_VK = await invoke<number>('default_ptt_key');
  } catch { /* keep VK_OEM_3 */ }
  setupBindButton('btn-bind-ptt', PTT_VK_KEY, 'setPttKey', DEFAULT_PTT_VK);
  setupBindButton('btn-bind-toggle', TOGGLE_VK_KEY, 'setToggleKey', null);
  // Push the PTT key to Rust on startup — the stored bind, or the default the
  // button shows, so the label and the watched key always agree.
  const ptt = localStorage.getItem(PTT_VK_KEY);
  const pttVk = ptt !== null ? parseInt(ptt, 10) : DEFAULT_PTT_VK;
  if (pttVk !== null && !Number.isNaN(pttVk)) sendToBackground('setPttKey', { vk: pttVk });
  const toggle = localStorage.getItem(TOGGLE_VK_KEY);
  if (toggle !== null) sendToBackground('setToggleKey', { vk: parseInt(toggle, 10) });
});

btnDebug.addEventListener('click', () => {
  debugEnabled = !debugEnabled;
  btnDebug.textContent = onOff(debugEnabled);
  btnDebug.classList.toggle('active', debugEnabled);
  scanRateRow.classList.toggle('hidden', !debugEnabled);
  setLoggingEnabled(debugEnabled);
  // Read by orchestrator when emitting scanner:scene events so the scanner
  // window only renders the tracking dot while Debug is on.
  window.__lolproxchat_debug_enabled = debugEnabled;
  // Hide the HSV thumbnail immediately when Debug flips off.
  if (!debugEnabled) {
    debugFilterThumb.classList.add('hidden');
    debugFilterThumb.removeAttribute('src');
  }
  // v0.3 (#11): re-fit window for new debug-row visibility
  syncOverlayHeight();
});

// HSV-filtered minimap preview — shown only while Debug is on. Listens to the
// same scanner:scene event the scanner window does; the panel renders the
// filtered image (which used to live painted on the scanner itself, but that
// fed back into the next capture cycle and required excluding the scanner
// from capture, which broke ShadowPlay / OBS).
const debugFilterThumb = document.getElementById('debug-filter-thumb') as HTMLImageElement;
listen<{ filteredImageUrl: string | null; debugEnabled: boolean }>('scanner:scene', (event) => {
  const { filteredImageUrl, debugEnabled: dbg } = event.payload;
  if (dbg && filteredImageUrl) {
    debugFilterThumb.src = filteredImageUrl;
    debugFilterThumb.classList.remove('hidden');
  } else {
    debugFilterThumb.classList.add('hidden');
    if (!filteredImageUrl) debugFilterThumb.removeAttribute('src');
  }
}).catch((e) => console.warn('[Overlay] scanner:scene listen failed:', e));

// v0.3 (#11): also re-fit when the thumbnail finishes loading (async image
// load can change scrollHeight after the toggle click already fired) and on
// every overlayUpdate (peer list grows / shrinks).
debugFilterThumb.addEventListener('load', syncOverlayHeight);
const panelEl = document.querySelector('.panel');
if (panelEl) {
  new ResizeObserver(syncOverlayHeight).observe(panelEl);
}
window.addEventListener('DOMContentLoaded', syncOverlayHeight);

// The input mode is remembered, and pushed at load as well as on change: it
// used to be neither, so Push to Talk chosen in the lobby (or in the previous
// game) showed on the panel while the next game's mic ran always-open. The
// keyboard hook only watches the push-to-talk key in push-to-talk mode.
const INPUT_MODE_KEY = 'lolproxchat.inputMode';
const inputModeSelect = document.getElementById('input-mode') as HTMLSelectElement;
function applyInputMode(): void {
  const mode = inputModeSelect.value;
  sendToBackground('updateSettings', { inputMode: mode });
  sendToBackground('setPttActive', { active: mode === 'ptt' });
}
try {
  const storedMode = localStorage.getItem(INPUT_MODE_KEY);
  if (storedMode === 'ptt' || storedMode === 'always') inputModeSelect.value = storedMode;
} catch { /* default: Always Open */ }
inputModeSelect.addEventListener('change', () => {
  try { localStorage.setItem(INPUT_MODE_KEY, inputModeSelect.value); } catch { /* still applied */ }
  applyInputMode();
});
applyInputMode();

const volumeInput = document.getElementById('input-volume') as HTMLInputElement;
const volumeLabel = document.getElementById('volume-label')!;
volumeInput.addEventListener('input', () => {
  const raw = parseInt(volumeInput.value);
  volumeLabel.textContent = String(raw);
  sendToBackground('updateSettings', { inputVolume: raw / 100 });
});

const scanRateInput = document.getElementById('input-scan-rate') as HTMLInputElement;
const scanRateLabel = document.getElementById('scan-rate-label')!;
// Each setScanRate tears down and restarts the tracking loop, so the label
// follows the drag live but the backend only hears the value the user settled on.
let scanRateDebounceId: number | null = null;
scanRateInput.addEventListener('input', () => {
  const raw = parseInt(scanRateInput.value);
  scanRateLabel.textContent = String(raw);
  // Map 0-100 → 1-60 FPS for backend scan rate (default 50 → 30 FPS)
  const fps = Math.max(1, Math.round(1 + (raw / 100) * 59));
  if (scanRateDebounceId !== null) clearTimeout(scanRateDebounceId);
  scanRateDebounceId = window.setTimeout(() => {
    scanRateDebounceId = null;
    sendToBackground('setScanRate', { fps });
  }, 200);
});

function sendToBackground(action: string, payload: any): void {
  // In Tauri, both background and overlay run in the same WebView,
  // so we use window events for communication
  window.dispatchEvent(new CustomEvent('overlayAction', { detail: { action, payload } }));
}

// Report the panel's current size to Rust so the click-through hit-test
// follows collapse/expand/settings open. Multiply by devicePixelRatio
// because offsetWidth/Height are CSS pixels but the Rust side compares
// against physical-pixel cursor coords from GetCursorPos.
let lastSentPanelWidth: number | null = null;
let lastSentPanelHeight: number | null = null;
const reportPanelSize = () => {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(panel.offsetWidth * dpr);
  const height = Math.round(panel.offsetHeight * dpr);
  // Same dedupe as syncOverlayHeight — the hit-rect only needs updating when
  // the panel actually changed size (collapse/expand/settings open).
  if (!shouldSendSize(lastSentPanelWidth, width) && !shouldSendSize(lastSentPanelHeight, height)) return;
  lastSentPanelWidth = width;
  lastSentPanelHeight = height;
  sendToBackground('panelResize', { width, height });
};
new ResizeObserver(reportPanelSize).observe(panel);
// Initial report once the layout has settled
requestAnimationFrame(reportPanelSize);

// --- Track active player row DOM elements for in-place updates ---
const playerRows: Map<string, {
  row: HTMLElement;
  nameSpan: HTMLElement;
  indicator: HTMLElement | null;
  volSlider: HTMLInputElement;
  muteBtn: HTMLButtonElement;
}> = new Map();

// Track whether a player slider is being actively dragged
let activeSliderPlayer: string | null = null;

function createPlayerRow(peer: NearbyPeer, localTeam: 'ORDER' | 'CHAOS' | null | undefined): HTMLElement {
  const row = document.createElement('div');
  const isAlly = localTeam ? peer.team === localTeam : peer.team === 'ORDER';
  row.className = 'player-row ' + (isAlly ? 'ally' : 'enemy');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName;
  nameSpan.title = peer.summonerName;
  row.appendChild(nameSpan);

  const indicator = document.createElement('span');
  indicator.className = 'player-muted-indicator';
  if (peer.isDead) {
    indicator.textContent = t('players.dead');
  } else if (peer.isMuted) {
    indicator.textContent = t('players.muted');
  } else {
    indicator.style.display = 'none';
  }
  row.appendChild(indicator);

  const volSlider = document.createElement('input') as HTMLInputElement;
  volSlider.type = 'range';
  volSlider.className = 'player-volume';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
  volSlider.addEventListener('mousedown', () => { activeSliderPlayer = peer.summonerName; });
  volSlider.addEventListener('mouseup', () => { activeSliderPlayer = null; });
  volSlider.addEventListener('input', () => {
    const vol = parseInt(volSlider.value) / 100;
    playerVolumes.set(peer.summonerName, vol);
    sendToBackground('setPlayerVolume', { name: peer.summonerName, volume: vol });
  });
  row.appendChild(volSlider);

  const muteBtn = document.createElement('button') as HTMLButtonElement;
  muteBtn.className = 'player-mute-btn' + (peer.isMutedByLocal ? ' muted' : '');
  muteBtn.textContent = t(peer.isMutedByLocal ? 'players.mutedByYou' : 'players.mute');
  muteBtn.addEventListener('click', () => {
    // Flip the UI immediately so the user gets feedback without waiting
    // for the next broadcastOverlayState tick. Backend state will confirm.
    const nowMuted = !muteBtn.classList.contains('muted');
    muteBtn.classList.toggle('muted', nowMuted);
    muteBtn.textContent = t(nowMuted ? 'players.mutedByYou' : 'players.mute');
    console.log('[Overlay] Mute toggled for', peer.summonerName, '→', nowMuted);
    sendToBackground('toggleMutePlayer', { name: peer.summonerName });
  });
  row.appendChild(muteBtn);

  playerRows.set(peer.summonerName, { row, nameSpan, indicator, volSlider, muteBtn });
  return row;
}

function updatePlayerRow(peer: NearbyPeer): void {
  const entry = playerRows.get(peer.summonerName);
  if (!entry) return;

  // Update indicator
  if (peer.isDead) {
    entry.indicator!.textContent = t('players.dead');
    entry.indicator!.style.display = '';
  } else if (peer.isMuted) {
    entry.indicator!.textContent = t('players.muted');
    entry.indicator!.style.display = '';
  } else {
    entry.indicator!.style.display = 'none';
  }

  // Don't touch slider if user is actively dragging it
  if (activeSliderPlayer !== peer.summonerName) {
    const expected = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
    if (entry.volSlider.value !== expected) {
      entry.volSlider.value = expected;
    }
  }

  // Update mute button
  const isMuted = peer.isMutedByLocal;
  entry.muteBtn.className = 'player-mute-btn' + (isMuted ? ' muted' : '');
  entry.muteBtn.textContent = t(isMuted ? 'players.mutedByYou' : 'players.mute');
}

// --- Render state ---
let lastState: OverlayState | null = null;

function renderState(state: OverlayState): void {
  lastState = state;
  // Color-only mute indication (see the click handlers) — label stays static.
  btnSelfMute.classList.toggle('active', state.selfMuted);
  btnMuteAll.classList.toggle('active', state.muteAll);

  // Sort: allies first, then by champion name
  const localTeam = state.localTeam ?? null;
  const sortedPeers = [...state.nearbyPeers].sort((a, b) => {
    if (localTeam) {
      const aAlly = a.team === localTeam;
      const bAlly = b.team === localTeam;
      if (aAlly !== bAlly) return aAlly ? -1 : 1;
    }
    return a.championName.localeCompare(b.championName);
  });

  // Build set of current peer names for diffing
  const currentNames = new Set(sortedPeers.map(p => p.summonerName));

  // Remove rows for peers that left
  for (const [name, entry] of playerRows) {
    if (!currentNames.has(name)) {
      entry.row.remove();
      playerRows.delete(name);
    }
  }

  // Update existing rows or create new ones, in sorted order.
  // Only reorder DOM when the sort order *actually* changed — re-appending
  // a slider mid-drag detaches it from its pointer-event sequence, which
  // is why the per-player volume slider felt "clicky" / had to be re-grabbed
  // at every tick (issue #12). At 10 Hz position ticks the order rarely
  // changes, so the common case is now a no-op.
  const desiredOrder = sortedPeers.map(p => p.summonerName);
  const currentOrder: string[] = [];
  for (const child of Array.from(playerList.children)) {
    for (const [name, entry] of playerRows) {
      if (entry.row === child) { currentOrder.push(name); break; }
    }
  }
  const orderChanged = currentOrder.length !== desiredOrder.length
    || currentOrder.some((n, i) => n !== desiredOrder[i]);

  for (const peer of sortedPeers) {
    let entry = playerRows.get(peer.summonerName);
    if (entry) {
      updatePlayerRow(peer);
    } else {
      const row = createPlayerRow(peer, localTeam);
      playerList.appendChild(row);
      entry = playerRows.get(peer.summonerName);
    }
    if (orderChanged && entry && entry.row.parentElement === playerList) {
      playerList.appendChild(entry.row);
    }
  }

  // Show/hide empty state with lifecycle-aware text
  const emptyText = state.lifecycleStatus ? translateStatus(state.lifecycleStatus) : t('players.waiting');
  const emptyState = playerList.querySelector('.empty-state');
  if (sortedPeers.length === 0) {
    if (!emptyState) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = emptyText;
      playerList.appendChild(emptyDiv);
    } else if (emptyState.textContent !== emptyText) {
      emptyState.textContent = emptyText;
    }
  } else if (emptyState) {
    emptyState.remove();
  }

  // Debug info: tracking state + position (only when debug enabled)
  const dbgEl = document.getElementById('debug-info')!;
  if (debugEnabled && (state.trackingState || state.lastPosition)) {
    const parts: string[] = [];
    if (state.trackingState) parts.push('tracking: ' + state.trackingState);
    if (state.lastPosition) {
      parts.push('pos: (' + Math.round(state.lastPosition.x) + ',' + Math.round(state.lastPosition.y) + ')');
    }
    dbgEl.textContent = parts.join(' | ');
    dbgEl.classList.remove('hidden');
  } else {
    dbgEl.classList.add('hidden');
  }
}

// --- Listen for state updates from background ---
window.addEventListener('overlayUpdate', ((event: CustomEvent) => {
  renderState(event.detail);
}) as EventListener);

// --- Language ---
// Applied at load, and again live from the Settings drop-down: everything the
// panel shows is re-labelled in place, no restart.
const languageSelect = document.getElementById('language') as HTMLSelectElement;
for (const { code, name } of LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  languageSelect.appendChild(opt);
}

function applyLanguage(): void {
  const lang = getLanguage();
  document.documentElement.lang = lang;
  languageSelect.value = lang;
  applyTranslations(document, lang);
  if (resetFeedbackId === null) btnResetPosition.textContent = t('settings.reset');
  btnCollapse.title = t(collapsed ? 'header.expand' : 'header.collapse');
  syncAutoUpdateButton();
  syncForceTurnButton();
  syncAllyProximityButton();
  syncCameraListenButton();
  btnDebug.textContent = onOff(debugEnabled);
  for (const relabel of bindRelabelers) relabel();
  if (updateStatusMsg) updateStatus.textContent = t(updateStatusMsg.key, updateStatusMsg.params);
  if (!settingsPanel.classList.contains('hidden')) refreshDeviceLists();
  if (lastState) renderState(lastState);
}

languageSelect.addEventListener('change', () => {
  setLanguage(languageSelect.value as Lang);
  applyLanguage();
});
// After the bind buttons are set up (queued above), so they are relabelled too.
queueMicrotask(applyLanguage);

console.log('LoLProxChat overlay loaded');

export {};
