import {
  getAllyProximity, setAllyProximity, getCameraListen, setCameraListen, getSharedReset, setSharedReset,
  applyAudioDefaultsOnce,
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

  test('the first launch of this build puts both toggles back on, once', () => {
    setAllyProximity(false);
    setCameraListen(false);
    setSharedReset(true);
    expect(applyAudioDefaultsOnce()).toBe(true);
    expect(getAllyProximity()).toBe(true);
    expect(getCameraListen()).toBe(true);
    // An opt-in is not a default to restore.
    expect(getSharedReset()).toBe(true);

    // Turned off again afterwards, it stays off across later launches.
    setAllyProximity(false);
    expect(applyAudioDefaultsOnce()).toBe(false);
    expect(getAllyProximity()).toBe(false);
  });

  test('the one-time defaults never throw when storage does', () => {
    const real = (globalThis as any).localStorage;
    (globalThis as any).localStorage = { getItem: () => { throw new Error('denied'); } };
    try {
      expect(applyAudioDefaultsOnce()).toBe(false);
    } finally {
      (globalThis as any).localStorage = real;
    }
  });

  test('an install that had turned a toggle on before v0.5.18 keeps it on', () => {
    store.set('lolproxchat.allyProximity', '1');
    store.set('lolproxchat.cameraListen', '1');
    expect(getAllyProximity()).toBe(true);
    expect(getCameraListen()).toBe(true);
  });

  test('shared RESET is off until turned on, and anything but "on" reads as off', () => {
    expect(getSharedReset()).toBe(false);
    store.set('lolproxchat.sharedReset', 'true');
    expect(getSharedReset()).toBe(false);
    setSharedReset(true);
    expect(store.get('lolproxchat.sharedReset')).toBe('1');
    expect(getSharedReset()).toBe(true);
    setSharedReset(false);
    expect(getSharedReset()).toBe(false);
  });

  test('shared RESET reads as off when storage cannot be read', () => {
    const real = (globalThis as any).localStorage;
    (globalThis as any).localStorage = { getItem: () => { throw new Error('blocked'); } };
    try {
      expect(getSharedReset()).toBe(false);
    } finally {
      (globalThis as any).localStorage = real;
    }
  });
});
