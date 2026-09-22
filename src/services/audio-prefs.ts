// Audio playback preferences. Currently just the "ally proximity" toggle, which
// makes teammates fade with distance (the same vision-range falloff as enemies)
// instead of always playing at full volume. Default off — most players want to
// hear their whole team; opting in trades that for positional ally audio (#22).

const ALLY_PROXIMITY_KEY = 'lolproxchat.allyProximity';

export function getAllyProximity(): boolean {
  return localStorage.getItem(ALLY_PROXIMITY_KEY) === '1';
}

export function setAllyProximity(enabled: boolean): void {
  if (enabled) localStorage.setItem(ALLY_PROXIMITY_KEY, '1');
  else localStorage.removeItem(ALLY_PROXIMITY_KEY);
}

// "Voice on camera" (#36): hear the map from wherever the camera is looking as
// well as from the champion's own position.
//
// Symmetric and mutual, both deliberately. Symmetric because the camera you
// listen from is published to the server and scored as a point you are
// AUDIBLE at — pan onto a fight to listen in and the people in it hear you.
// Mutual because a camera only counts between two players who have both
// turned this on: with it off you publish no camera, nobody else's can reach
// you, and you are heard only by players actually near you on the map.
//
// Default off, and deliberately so: it widens what the app can tell you about
// enemies beyond your champion's own vision, which is the boundary
// docs/compliance.md draws. Opting in is the user's call to make knowingly,
// and someone who leaves it off is not exposed by anyone else's choice.
const CAMERA_LISTEN_KEY = 'lolproxchat.cameraListen';

export function getCameraListen(): boolean {
  return localStorage.getItem(CAMERA_LISTEN_KEY) === '1';
}

export function setCameraListen(enabled: boolean): void {
  if (enabled) localStorage.setItem(CAMERA_LISTEN_KEY, '1');
  else localStorage.removeItem(CAMERA_LISTEN_KEY);
}
