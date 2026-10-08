import { setLoggingEnabled } from '../core/logging';
// Silence verbose logs by default — the overlay's Debug toggle flips this on.
setLoggingEnabled(false);

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Orchestrator } from '../services/orchestrator';
import { isAutoUpdateEnabled } from '../services/updater';
import '../core/window-globals';

console.log('[LoLProxChat] Background script loading...');

const orchestrator = new Orchestrator();
orchestrator.start();

console.log('[LoLProxChat] Orchestrator started');

// Listen for messages from overlay (Tauri uses window events instead of Overwolf messaging)
window.addEventListener('overlayAction', ((event: CustomEvent) => {
  const { action, payload } = event.detail;
  console.log('[LoLProxChat] Received action from overlay:', action);
  switch (action) {
    case 'toggleSelfMute':
      orchestrator.toggleSelfMute();
      break;
    case 'toggleMuteAll':
      orchestrator.toggleMuteAll();
      break;
    case 'toggleMutePlayer':
      orchestrator.toggleMutePlayer(payload.name);
      break;
    case 'setPlayerVolume':
      orchestrator.setPlayerVolume(payload.name, payload.volume);
      break;
    case 'resetPosition':
      orchestrator.resetPosition();
      break;
    case 'setScanRate':
      orchestrator.setScanRate(payload.fps);
      break;
    case 'setPTT':
      orchestrator.setPTTState(payload.held);
      break;
    case 'updateSettings':
      orchestrator.updateSettings(payload);
      break;
    case 'setPttKey':
      invoke('set_ptt_key', { vk: payload.vk })
        .catch((e) => console.warn('[Background] set_ptt_key failed:', e));
      break;
    case 'setPttActive':
      invoke('set_ptt_active', { active: !!payload.active })
        .catch((e) => console.warn('[Background] set_ptt_active failed:', e));
      break;
    case 'setToggleKey':
      invoke('set_toggle_key', { vk: payload.vk })
        .catch((e) => console.warn('[Background] set_toggle_key failed:', e));
      break;
    case 'calibrationBounds':
      orchestrator.setMinimapCalibration(payload);
      break;
    case 'panelResize':
      // Tell the Rust click-through loop how big the interactive zone is.
      invoke('set_panel_size', { width: payload.width, height: payload.height })
        .catch(() => { /* ignore — loop falls back to last value */ });
      break;
    case 'resizeOverlay':
      // v0.3 (#11): dynamic overlay window height based on measured panel
      // scrollHeight. Rust clamps + updates the hit-rect.
      invoke('resize_overlay', { height: payload.height })
        .catch((e) => console.warn('[Background] resize_overlay failed:', e));
      break;
    case 'setInputDevice':
      orchestrator.applyInputDevice(payload.id);
      break;
    case 'setOutputDevice':
      orchestrator.applyOutputDevice(payload.id);
      break;
    case 'openLogFolder':
      invoke('open_log_folder')
        .catch((e) => console.warn('[LoLProxChat] open_log_folder failed:', e));
      break;
  }
}) as EventListener);

// Global shortcuts: Ctrl+Shift+M toggles self-mute, F8 is push-to-talk.
listen<string>('global_shortcut', (event) => {
  console.log('[Shortcut] Fired:', event.payload);
  switch (event.payload) {
    case 'toggleMute':
      orchestrator.toggleSelfMute();
      break;
    case 'pttDown':
      orchestrator.setPTTState(true);
      break;
    case 'pttUp':
      orchestrator.setPTTState(false);
      break;
  }
}).catch((e) => console.warn('[LoLProxChat] global_shortcut listen failed:', e));

console.log('LoLProxChat background service started');

// Auto-check for updates on launch if user has opted in. Runs after a short
// delay so the overlay's check-update handler has a chance to register.
if (isAutoUpdateEnabled()) {
  setTimeout(() => {
    const runCheck = window.__proxchatRunUpdateCheck;
    if (typeof runCheck === 'function') {
      runCheck(false);
    }
  }, 5000);
}
