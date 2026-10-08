// The microphone failing to open, against the REAL AudioService over the e2e
// WebAudio fakes. 2026-10-07: one tester's mic was refused at every session
// start, which used to abort the session — no voice in either direction.
import { installDomShims } from '../e2e/setup/dom';
import { installWebAudioFakes, FakeMediaStream } from '../e2e/fakes/webaudio';
import { AudioService, describeMicError } from '../../src/services/audio';
import { SignalingService } from '../../src/services/signaling';

let storedInput: string | null = null;
jest.mock('../../src/services/devices', () => ({
  ...jest.requireActual('../../src/services/devices'),
  getStoredInputDeviceId: () => storedInput,
  getStoredOutputDeviceId: () => null,
}));

function domError(name: string, message = ''): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

let getUserMedia: jest.Mock;

beforeAll(() => installDomShims());

beforeEach(() => {
  jest.useFakeTimers();
  installWebAudioFakes();
  storedInput = null;
  getUserMedia = jest.fn(async () => new FakeMediaStream());
  (navigator as any).mediaDevices.getUserMedia = getUserMedia;
  jest.spyOn(console, 'log').mockImplementation(() => { /* quiet */ });
  jest.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ });
  jest.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const newService = () => new AudioService(new SignalingService(), 'me');

test('a refused microphone leaves a working, listen-only service', async () => {
  getUserMedia.mockRejectedValue(domError('NotAllowedError', 'Permission denied'));
  const audio = newService();
  await expect(audio.initMicrophone()).resolves.toBeUndefined();
  expect(audio.getMicError()).toBe('NotAllowedError: Permission denied');
  audio.cleanup();
});

test('a later retry that opens the microphone clears the error', async () => {
  getUserMedia.mockRejectedValueOnce(domError('NotAllowedError', 'Permission denied'));
  const audio = newService();
  await audio.initMicrophone();
  await audio.applyInputDevice(null);
  expect(audio.getMicError()).toBeNull();
  audio.cleanup();
});

test('a chosen device that is gone falls back to the default', async () => {
  storedInput = 'unplugged-headset';
  getUserMedia.mockImplementation(async (c: { audio: MediaTrackConstraints }) => {
    if (c.audio.deviceId) throw domError('OverconstrainedError');
    return new FakeMediaStream();
  });
  const audio = newService();
  await audio.initMicrophone();
  expect(audio.getMicError()).toBeNull();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  audio.cleanup();
});

test('a retry that lands after the session ended releases the microphone', async () => {
  getUserMedia.mockRejectedValueOnce(domError('NotAllowedError'));
  const audio = newService();
  await audio.initMicrophone();
  let open!: (s: FakeMediaStream) => void;
  getUserMedia.mockImplementationOnce(() => new Promise((r) => { open = r; }));
  const retry = audio.applyInputDevice(null);
  await Promise.resolve();
  audio.cleanup();
  const late = new FakeMediaStream();
  open(late);
  await retry;
  expect(late.tracks[0].stopped).toBe(true);
  expect(audio.getMicError()).toBeNull();
});

test('describeMicError names the DOMException', () => {
  expect(describeMicError(domError('NotFoundError', 'Requested device not found')))
    .toBe('NotFoundError: Requested device not found');
  expect(describeMicError('boom')).toBe('boom');
});
