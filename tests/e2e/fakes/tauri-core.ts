// Stand-in for '@tauri-apps/api/core', wired in by moduleNameMapper in
// jest.e2e.config.js rather than by jest.mock() from a helper: jest.mock is
// hoisted only within the file that calls it, so an imported helper registers
// the mock after the module under test has already captured the real namespace
// and silently does nothing.
//
// A command that is not in the table REJECTS. Resolving unknown commands hides
// exactly the mistake this table exists to catch — production reaching for a
// backend call the harness never modelled.

import type { GameWindowInfoDto } from '../../../src/core/game-window';

export interface TauriCall { command: string; args: unknown }

export const tauriCalls: TauriCall[] = [];

/** 1080p borderless on a single primary monitor — the ordinary case. */
export const defaultGameWindowInfo: GameWindowInfoDto = {
  found: true,
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  matchedBy: 'class',
  windowTitle: 'League of Legends (TM) Client',
  processName: 'League of Legends.exe',
  virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
  primaryScreen: { x: 0, y: 0, width: 1920, height: 1080 },
  error: null,
};

export const tauriState = {
  gameWindowInfo: { ...defaultGameWindowInfo },
  leagueConfig: '[General]\nWindowMode=1\n[HUD]\nMinimapScale=1.0\n',
};

const handlers: Record<string, () => unknown> = {
  get_game_window_info: () => tauriState.gameWindowInfo,
  read_league_config_file: () => tauriState.leagueConfig,
  set_capture_bounds: () => undefined,
  position_scanner: () => undefined,
  hide_scanner: () => undefined,
  append_log: () => undefined,
  // Only reachable if something bypasses the mapped event module.
  'plugin:event|emit': () => undefined,
};

export async function invoke<T>(command: string, args?: unknown): Promise<T> {
  tauriCalls.push({ command, args });
  const handler = handlers[command];
  if (!handler) {
    throw new Error('[e2e] unmocked Tauri command: ' + command);
  }
  return handler() as T;
}

export function invokedCommands(): string[] {
  return tauriCalls.map((c) => c.command);
}

export function resetTauriFake(): void {
  tauriCalls.length = 0;
  tauriState.gameWindowInfo = { ...defaultGameWindowInfo };
  tauriState.leagueConfig = '[General]\nWindowMode=1\n[HUD]\nMinimapScale=1.0\n';
}
