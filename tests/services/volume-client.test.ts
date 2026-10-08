import { VolumeClient } from '../../src/services/volume-client';

// volume-client is pure transport; stub fetch and assert what we put on the wire.
// The #22 ally-proximity flag is the contract that matters here: a field-name typo
// would silently no-op against the server (which just wouldn't see the flag), so
// the server's own tests can't catch it — this one does.
const fetchMock = jest.fn();
(globalThis as any).fetch = fetchMock;

describe('VolumeClient.computeVolumes', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ peerVolumes: {} }),
    });
  });

  test('sends the allyProximity flag (and identity/position) in the request body', async () => {
    const client = new VolumeClient();
    await client.computeVolumes({ x: 1, y: 2 }, 'room-1', 'Me', true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      myPosition: { x: 1, y: 2 },
      roomId: 'room-1',
      name: 'Me',
      allyProximity: true,
    });
  });

  test('passes allyProximity=false through (global/full ally volume)', async () => {
    const client = new VolumeClient();
    await client.computeVolumes({ x: 0, y: 0 }, 'room-2', 'Me', false);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.allyProximity).toBe(false);
  });
});
