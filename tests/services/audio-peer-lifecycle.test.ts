import { SignalMessage } from '../../src/services/signaling';

// PeerConnection.create awaits an ICE-server fetch, so two paths — our own
// connectToPeer and an incoming offer — could both be inside that await for the
// same peer and both build a connection, the loser silently overwritten in the
// peers map without being closed. The remote then completed against the orphan,
// which is never reached by applyPeerVolumes and so plays at volume 0 forever:
// "I couldn't hear one specific player all game".
//
// Mocking the PeerConnection module is what makes that race reproducible rather
// than merely arguable — the fake is one class with no DOM, and the test drives
// create() resolution order by hand.
jest.mock('../../src/services/peer-connection', () => ({
  PeerConnection: { create: jest.fn() },
}));
jest.mock('../../src/services/devices', () => ({
  getStoredInputDeviceId: () => null,
  getStoredOutputDeviceId: () => null,
}));

import { AudioService } from '../../src/services/audio';
import { PeerConnection } from '../../src/services/peer-connection';

const createMock = PeerConnection.create as unknown as jest.Mock;

class FakePeer {
  onIceCandidate: ((c: any) => void) | null = null;
  onIceFailed: (() => void) | null = null;
  close = jest.fn();
  setOutputDevice = jest.fn().mockResolvedValue(undefined);
  addLocalStream = jest.fn();
  handleOffer = jest.fn().mockResolvedValue({ type: 'answer', sdp: 'a' });
  handleAnswer = jest.fn().mockResolvedValue(undefined);
  addIceCandidate = jest.fn().mockResolvedValue(undefined);
  createOffer = jest.fn().mockResolvedValue({ type: 'offer', sdp: 'o' });
  constructor(readonly remoteName: string) {}
}

interface CreateCall {
  name: string;
  peer: FakePeer;
  resolve: () => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

let creates: CreateCall[];
let autoSettle: boolean;
let signaling: { sendSignal: jest.Mock };
let audio: AudioService;

/** Resolve every create() that is still pending, with its own FakePeer. */
function settleAllCreates(): void {
  for (const c of creates) {
    if (!c.settled) { c.settled = true; c.resolve(); }
  }
}

/** Let queued microtasks and .then chains run to completion. */
function drain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function offer(from: string): SignalMessage {
  return { type: 'offer', from, to: 'me', payload: { type: 'offer', sdp: 'remote' } };
}

function candidate(from: string, id: string): SignalMessage {
  return { type: 'ice-candidate', from, to: 'me', payload: { candidate: id } };
}

function sentOffersTo(name: string): SignalMessage[] {
  return signaling.sendSignal.mock.calls
    .map((c) => c[0] as SignalMessage)
    .filter((s) => s.type === 'offer' && s.to === name);
}

function sentAnswersTo(name: string): SignalMessage[] {
  return signaling.sendSignal.mock.calls
    .map((c) => c[0] as SignalMessage)
    .filter((s) => s.type === 'answer' && s.to === name);
}

function makeAudio(localName: string): AudioService {
  signaling = { sendSignal: jest.fn() };
  return new AudioService(signaling as any, localName);
}

beforeEach(() => {
  creates = [];
  autoSettle = true;
  createMock.mockReset();
  createMock.mockImplementation((name: string) => {
    const peer = new FakePeer(name);
    let resolveFn!: (p: FakePeer) => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<FakePeer>((res, rej) => { resolveFn = res; rejectFn = rej; });
    const entry: CreateCall = {
      name,
      peer,
      resolve: () => resolveFn(peer),
      reject: (e) => rejectFn(e),
      settled: false,
    };
    creates.push(entry);
    if (autoSettle) { entry.settled = true; entry.resolve(); }
    return promise;
  });
  jest.spyOn(console, 'log').mockImplementation(() => { /* keep test output clean */ });
  jest.spyOn(console, 'warn').mockImplementation(() => { /* keep test output clean */ });
  jest.spyOn(console, 'error').mockImplementation(() => { /* keep test output clean */ });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the connectToPeer / incoming-offer race', () => {
  test('connectToPeer claims first, the offer joins it — one connection, one answer', async () => {
    // Zed is the non-initiator against Ahri ('A' < 'Z'), which is the side the
    // race is reachable on. Asserts exactly one RTCPeerConnection is built, the
    // one in the map is the one that answered, and no peer is left orphaned.
    // Pre-fix: two creates, and handleOffer ran on the instance that the second
    // create then evicted from the map — the permanently-silent peer.
    autoSettle = false;
    audio = makeAudio('Zed');

    const connecting = audio.connectToPeer('Ahri', false);
    const answering = audio.handleSignal(offer('Ahri'));
    settleAllCreates();
    await Promise.all([connecting, answering]);
    await drain();

    expect(createMock).toHaveBeenCalledTimes(1);
    const peer = creates[0].peer;
    expect(audio.getPeer('Ahri')).toBe(peer as any);
    expect(peer.handleOffer).toHaveBeenCalledTimes(1);
    expect(sentAnswersTo('Ahri')).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
  });

  test('the offer claims first, an INITIATOR connectToPeer joins and does not offer', async () => {
    // Glare under the race: the remote reached us first, so our own
    // connectToPeer gets created:false and must not start a rival negotiation.
    // This is the suppression path — an off-by-one in the `created` gate here
    // produces either zero offers or a duplicate one.
    autoSettle = false;
    audio = makeAudio('Ahri');

    const answering = audio.handleSignal(offer('Zed'));
    const connecting = audio.connectToPeer('Zed', true);
    settleAllCreates();
    await Promise.all([answering, connecting]);
    await drain();

    expect(createMock).toHaveBeenCalledTimes(1);
    const peer = creates[0].peer;
    expect(audio.getPeer('Zed')).toBe(peer as any);
    expect(sentAnswersTo('Zed')).toHaveLength(1);
    expect(sentOffersTo('Zed')).toHaveLength(0);
    expect(peer.createOffer).not.toHaveBeenCalled();
  });

  test('three concurrent initiator connectToPeer calls produce one connection and one offer', async () => {
    // The shape the orchestrator actually produces: handlePeerPosition calls
    // connectToPeer on every position broadcast (up to 10 Hz) while hasPeer is
    // false, which it stays for the whole creation window. Only the claiming
    // call may offer.
    autoSettle = false;
    audio = makeAudio('Ahri');

    const calls = [
      audio.connectToPeer('Zed', true),
      audio.connectToPeer('Zed', true),
      audio.connectToPeer('Zed', true),
    ];
    settleAllCreates();
    await Promise.all(calls);
    await drain();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(sentOffersTo('Zed')).toHaveLength(1);
    expect(creates[0].peer.createOffer).toHaveBeenCalledTimes(1);
  });
});

describe('negotiation roles', () => {
  test('the initiator offers exactly once', async () => {
    audio = makeAudio('Ahri');
    await audio.connectToPeer('Zed', true);
    await drain();

    expect(sentOffersTo('Zed')).toHaveLength(1);
    expect(audio.hasPeer('Zed')).toBe(true);
  });

  test('the non-initiator never offers', async () => {
    audio = makeAudio('Zed');
    await audio.connectToPeer('Ahri', false);
    await drain();

    expect(sentOffersTo('Ahri')).toHaveLength(0);
    expect(creates[0].peer.createOffer).not.toHaveBeenCalled();
  });

  test('connectToPeer after an already-answered offer does not offer', async () => {
    // Sequential glare (no race): the remote drove negotiation and we answered.
    audio = makeAudio('Ahri');
    await audio.handleSignal(offer('Zed'));
    await audio.connectToPeer('Zed', true);
    await drain();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(sentOffersTo('Zed')).toHaveLength(0);
  });

  test('a genuine PeerConnection.create failure still propagates out of connectToPeer', async () => {
    // The orchestrator deletes its peerState and retries on a throw, so a real
    // failure must not be swallowed the way an abandoned creation is.
    autoSettle = false;
    audio = makeAudio('Zed');

    const connecting = audio.connectToPeer('Ahri', false);
    creates[0].settled = true;
    creates[0].reject(new Error('ice fetch exploded'));

    await expect(connecting).rejects.toThrow('ice fetch exploded');
    await expect(connecting.catch((e) => (e as Error).name)).resolves.toBe('Error');
    expect(audio.hasPeer('Ahri')).toBe(false);
  });
});

describe('pending signal buffer', () => {
  test('candidates buffered before creation are flushed for a peer created by an INCOMING OFFER', async () => {
    // The flush used to live only at the tail of connectToPeer, so a peer born
    // from an offer drained its buffer only by luck. With connectToPeer now
    // returning early for a connection it did not create, that luck is gone.
    audio = makeAudio('Zed');

    await audio.handleSignal(candidate('Ahri', 'c1'));
    expect(createMock).not.toHaveBeenCalled();

    await audio.handleSignal(offer('Ahri'));
    await drain();

    expect(creates[0].peer.addIceCandidate).toHaveBeenCalledWith({ candidate: 'c1' });
  });

  test('the buffer is capped and keeps the OLDEST candidates', async () => {
    // Host and server-reflexive candidates arrive first and are what carry a
    // same-NAT connection, so overflow drops the newest. Pre-fix the buffer was
    // unbounded: all 200 were replayed.
    audio = makeAudio('Zed');

    for (let i = 0; i < 200; i++) {
      await audio.handleSignal(candidate('Ahri', 'c' + i));
    }
    await audio.handleSignal(offer('Ahri'));
    await drain();

    const replayed = creates[0].peer.addIceCandidate.mock.calls.map((c) => c[0].candidate);
    expect(replayed).toHaveLength(64);
    expect(replayed[0]).toBe('c0');
    expect(replayed[63]).toBe('c63');
  });

  test('disconnecting clears the buffer so a rejoin does not replay the old connection candidates', async () => {
    // Stale candidates carry the previous connection's ufrag; replaying them
    // into a fresh RTCPeerConnection is pure noise. Asserting the post-rejoin
    // candidate IS delivered keeps this from passing merely because nothing
    // was replayed at all.
    audio = makeAudio('Zed');

    await audio.handleSignal(candidate('Ahri', 'stale'));
    audio.disconnectPeer('Ahri');
    await audio.handleSignal(candidate('Ahri', 'fresh'));

    await audio.handleSignal(offer('Ahri'));
    await drain();

    const replayed = creates[0].peer.addIceCandidate.mock.calls.map((c) => c[0].candidate);
    expect(replayed).toEqual(['fresh']);
  });
});

describe('creations that outlive their reason', () => {
  test('a peer that leaves mid-creation is closed and never enters the map', async () => {
    // Pre-fix the create landed peers.set() after disconnectPeer had run: a
    // live RTCPeerConnection plus its 10s stats interval, leaked for the
    // lifetime of the process.
    autoSettle = false;
    audio = makeAudio('Zed');

    const connecting = audio.connectToPeer('Ahri', false);
    audio.disconnectPeer('Ahri');
    settleAllCreates();
    await expect(connecting).resolves.toBeUndefined();

    expect(creates[0].peer.close).toHaveBeenCalledTimes(1);
    expect(audio.hasPeer('Ahri')).toBe(false);
  });

  test('a session ending mid-creation closes the peer and never enters the map', async () => {
    autoSettle = false;
    audio = makeAudio('Zed');

    const connecting = audio.connectToPeer('Ahri', false);
    audio.cleanup();
    settleAllCreates();
    await expect(connecting).resolves.toBeUndefined();

    expect(creates[0].peer.close).toHaveBeenCalledTimes(1);
    expect(audio.hasPeer('Ahri')).toBe(false);
  });
});

describe('ICE restart wiring', () => {
  test('a peer created via an incoming offer gets onIceFailed when we are the name-order initiator', async () => {
    // Reachable after a peer leaves and rejoins: the remote re-offers and our
    // side re-creates through the offer branch, which used to wire no restart
    // handler at all for the rest of the game.
    audio = makeAudio('Ahri');
    await audio.handleSignal(offer('Zed'));
    await drain();

    const peer = creates[0].peer;
    expect(typeof peer.onIceFailed).toBe('function');

    peer.onIceFailed!();
    await drain();

    expect(peer.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(sentOffersTo('Zed')).toHaveLength(1);
  });

  test('a stale onIceFailed closure does not renegotiate after the peer is dropped', async () => {
    audio = makeAudio('Ahri');
    await audio.handleSignal(offer('Zed'));
    await drain();

    const peer = creates[0].peer;
    audio.disconnectPeer('Zed');
    peer.onIceFailed!();
    await drain();

    expect(peer.createOffer).not.toHaveBeenCalled();
    expect(sentOffersTo('Zed')).toHaveLength(0);
  });
});
