import {
  getAllyProximity, setAllyProximity, getCameraListen, setCameraListen,
} from '../../src/services/audio-prefs';

// The node test environment has no localStorage; a plain map is all the
// module touches.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};

describe('audio prefs', () => {
  beforeEach(() => store.clear());

  test('both toggles are on for a fresh install', () => {
    expect(getAllyProximity()).toBe(true);
    expect(getCameraListen()).toBe(true);
  });

  test('turning one off survives a restart, and does not touch the other', () => {
    setAllyProximity(false);
    expect(store.get('lolproxchat.allyProximity')).toBe('0');
    expect(getAllyProximity()).toBe(false);
    expect(getCameraListen()).toBe(true);

    setCameraListen(false);
    expect(getCameraListen()).toBe(false);
    setCameraListen(true);
    expect(getCameraListen()).toBe(true);
    expect(getAllyProximity()).toBe(false);
  });

  test('an install that had turned a toggle on before v0.5.18 keeps it on', () => {
    store.set('lolproxchat.allyProximity', '1');
    store.set('lolproxchat.cameraListen', '1');
    expect(getAllyProximity()).toBe(true);
    expect(getCameraListen()).toBe(true);
  });
});
