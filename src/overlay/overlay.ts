import { setLoggingEnabled } from '../core/logging';
import { listen } from '@tauri-apps/api/event';
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
import { getAllyProximity, setAllyProximity } from '../services/audio-prefs';
import { computeDesiredHeight } from './resize-helpers';
import { browserKeyToWin32Vk, humanizeVk } from '../core/keymap';
import '../core/window-globals';

// v0.3 (#11): dynamic overlay-window resize so the panel grows to fit
// debug-thumbnail / settings content and shrinks back when they collapse.
// requestAnimationFrame-batched so we don't ping Rust at full frame rate
// when ResizeObserver fires rapidly (image load, etc).
let resizeQueued = false;
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
    sendToBackground('resizeOverlay', { height: Math.round(desired * dpr) });
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
  defaultOpt.textContent = 'Default';
  const opts: HTMLOptionElement[] = [defaultOpt];
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `(unnamed ${d.kind})`;
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
  btnCollapse.title = collapsed ? 'Expand' : 'Collapse';
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
  btnAutoUpdate.textContent = on ? 'ON' : 'OFF';
  btnAutoUpdate.classList.toggle('active', on);
}
queueMicrotask(syncAutoUpdateButton);

btnAutoUpdate.addEventListener('click', () => {
  setAutoUpdateEnabled(!isAutoUpdateEnabled());
  syncAutoUpdateButton();
});

async function runUpdateCheck(triggeredByUser: boolean): Promise<void> {
  updateStatus.textContent = 'Checking for updates…';
  try {
    const info = await checkForUpdate();
    if (info.update_available && info.download_url) {
      updateStatus.textContent = 'Update available: v' + info.latest_version + ' — applying…';
      await downloadAndApply(info.download_url);
      // If apply succeeds, the process exits before we reach here
    } else {
      updateStatus.textContent = triggeredByUser
        ? 'Up to date (v' + info.current_version + ')'
        : '';
    }
  } catch (e) {
    updateStatus.textContent = 'Update check failed: ' + (e as Error).message;
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
  btnForceTurn.textContent = on ? 'ON' : 'OFF';
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
  btnAllyProximity.textContent = on ? 'ON' : 'OFF';
  btnAllyProximity.classList.toggle('active', on);
}
queueMicrotask(syncAllyProximityButton);
btnAllyProximity.addEventListener('click', () => {
  setAllyProximity(!getAllyProximity());
  syncAllyProximityButton();
});

// v0.3 (#1): PTT + toggle-mute key rebind. The Rust WH_KEYBOARD_LL hook
// reads the bound VK code from atomics it exposes via set_ptt_key /
// set_toggle_key Tauri commands. UI pattern: click the button → "Press a
// key..." prompt → capture next keydown → translate to Win32 VK → persist
// + push to Rust.
const PTT_VK_KEY = 'lolproxchat.pttVk';
const TOGGLE_VK_KEY = 'lolproxchat.toggleVk';
const DEFAULT_PTT_VK: number | null = null;  // unbound by default (#27); Caps Lock as PTT ate the key — bind explicitly in Settings
const FORBIDDEN_CODES = new Set([
  'Escape', 'Tab',
  // Common LoL bindings — would conflict with gameplay even though our
  // hook fires first.
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyD', 'KeyF', 'KeyB', 'KeyP',
  // Modifier-only is bad UX (always pressed during typing combos)
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

function setupBindButton(buttonId: string, storageKey: string, backgroundCmd: string, defaultVk: number | null): void {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  if (!btn) return;
  const stored = localStorage.getItem(storageKey);
  const initialVk = stored !== null ? parseInt(stored, 10) : defaultVk;
  if (initialVk !== null && !Number.isNaN(initialVk) && initialVk > 0) {
    btn.textContent = humanizeVk(initialVk);
  } else {
    btn.textContent = '(unbound)';
  }

  btn.addEventListener('click', () => {
    const originalText = btn.textContent || '(unbound)';
    btn.textContent = 'Press a key…';
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
        restore(originalText);
        return;
      }
      if (FORBIDDEN_CODES.has(e.code)) {
        restore('(LoL/system key — pick another)');
        setTimeout(() => restore(originalText), 1500);
        return;
      }
      const vk = browserKeyToWin32Vk(e.code);
      if (vk === null) {
        restore('(key not supported)');
        setTimeout(() => restore(originalText), 1500);
        return;
      }
      localStorage.setItem(storageKey, String(vk));
      sendToBackground(backgroundCmd, { vk });
      restore(humanizeVk(vk));
    };
    window.addEventListener('keydown', onKey, true);
  });
}

queueMicrotask(() => {
  setupBindButton('btn-bind-ptt', PTT_VK_KEY, 'setPttKey', DEFAULT_PTT_VK);
  setupBindButton('btn-bind-toggle', TOGGLE_VK_KEY, 'setToggleKey', null);
  // Push any stored bindings to Rust on startup so user prefs survive restart.
  const ptt = localStorage.getItem(PTT_VK_KEY);
  if (ptt !== null) sendToBackground('setPttKey', { vk: parseInt(ptt, 10) });
  const toggle = localStorage.getItem(TOGGLE_VK_KEY);
  if (toggle !== null) sendToBackground('setToggleKey', { vk: parseInt(toggle, 10) });
});

btnDebug.addEventListener('click', () => {
  debugEnabled = !debugEnabled;
  btnDebug.textContent = debugEnabled ? 'ON' : 'OFF';
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

document.getElementById('input-mode')!.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  sendToBackground('updateSettings', { inputMode: mode });
});

const volumeInput = document.getElementById('input-volume') as HTMLInputElement;
const volumeLabel = document.getElementById('volume-label')!;
volumeInput.addEventListener('input', () => {
  const raw = parseInt(volumeInput.value);
  volumeLabel.textContent = String(raw);
  sendToBackground('updateSettings', { inputVolume: raw / 100 });
});

const scanRateInput = document.getElementById('input-scan-rate') as HTMLInputElement;
const scanRateLabel = document.getElementById('scan-rate-label')!;
scanRateInput.addEventListener('input', () => {
  const raw = parseInt(scanRateInput.value);
  scanRateLabel.textContent = String(raw);
  // Map 0-100 → 1-60 FPS for backend scan rate (default 50 → 30 FPS)
  const fps = Math.max(1, Math.round(1 + (raw / 100) * 59));
  sendToBackground('setScanRate', { fps });
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
const reportPanelSize = () => {
  const dpr = window.devicePixelRatio || 1;
  sendToBackground('panelResize', {
    width: Math.round(panel.offsetWidth * dpr),
    height: Math.round(panel.offsetHeight * dpr),
  });
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
    indicator.textContent = 'DEAD';
  } else if (peer.isMuted) {
    indicator.textContent = 'MUTED';
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
  muteBtn.textContent = peer.isMutedByLocal ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    // Flip the UI immediately so the user gets feedback without waiting
    // for the next broadcastOverlayState tick. Backend state will confirm.
    const nowMuted = !muteBtn.classList.contains('muted');
    muteBtn.classList.toggle('muted', nowMuted);
    muteBtn.textContent = nowMuted ? 'MUTED' : 'MUTE';
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
    entry.indicator!.textContent = 'DEAD';
    entry.indicator!.style.display = '';
  } else if (peer.isMuted) {
    entry.indicator!.textContent = 'MUTED';
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
  entry.muteBtn.textContent = isMuted ? 'MUTED' : 'MUTE';
}

// --- Render state ---
function renderState(state: OverlayState): void {
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
  const emptyText = state.lifecycleStatus || 'Waiting for nearby players...';
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

console.log('LoLProxChat overlay loaded');

export {};
