// Panel toggles: the "ally proximity" and "voice on camera" audio settings,
// and shared RESET (bottom of the file). The two audio toggles default ON
// since v0.5.18, so each is stored explicitly as '1' or '0' and a missing key
// reads as the default. Before v0.5.18 they defaulted off and "off" was stored
// by removing the key, so an install that had turned one off reads as on after
// the update; there is no way to tell the two apart.

const ALLY_PROXIMITY_KEY = 'lolproxchat.allyProximity';
const CAMERA_LISTEN_KEY = 'lolproxchat.cameraListen';

function readToggle(key: string): boolean {
  return localStorage.getItem(key) !== '0';
}

function writeToggle(key: string, enabled: boolean): void {
  localStorage.setItem(key, enabled ? '1' : '0');
}

// Ally proximity (#22): teammates fade with distance (the same vision-range
// falloff as enemies) instead of always playing at full volume. Default on, so
// out of the box the whole lobby is positional; turning it off trades that for
// hearing your whole team everywhere.
export function getAllyProximity(): boolean {
  return readToggle(ALLY_PROXIMITY_KEY);
}

export function setAllyProximity(enabled: boolean): void {
  writeToggle(ALLY_PROXIMITY_KEY, enabled);
}

// "Voice on camera" (#36): hear the map from wherever the camera is looking as
// well as from the champion's own position.
//
// One-way and mutual, both deliberately. One-way because the camera is a point
// you listen from, never one you are heard at: pan onto a fight and you hear
// it, while the people in it hear you only from where your champion stands.
// Mutual because a camera only counts between two players who have both
// turned this on: with it off you publish no camera, nobody else's can reach
// you, and you are heard only by players actually near you on the map.
//
// Default on since v0.5.18, the maintainer's call. It widens what the app can
// tell you about enemies beyond your champion's own vision, which is the
// boundary docs/compliance.md draws; the mutual rule above is what still lets
// one player opt out unilaterally.
export function getCameraListen(): boolean {
  return readToggle(CAMERA_LISTEN_KEY);
}

export function setCameraListen(enabled: boolean): void {
  writeToggle(CAMERA_LISTEN_KEY, enabled);
}

// Shared RESET: pressing RESET also asks everyone else in the game to re-find
// their own icon, and their RESETs re-find ours — but only between players who
// have all turned this on. Off by default and stored as '1' only, unlike the
// two toggles above: a missing or unreadable key is off.
//
// With it off the client tells the server so on join, the server sends it no
// shared RESET at all, and a 'reset' that arrives anyway (an older or
// misbehaving server) is dropped here — see Orchestrator.handleRemoteReset.
const SHARED_RESET_KEY = 'lolproxchat.sharedReset';

export function getSharedReset(): boolean {
  try {
    return localStorage.getItem(SHARED_RESET_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSharedReset(enabled: boolean): void {
  writeToggle(SHARED_RESET_KEY, enabled);
}
