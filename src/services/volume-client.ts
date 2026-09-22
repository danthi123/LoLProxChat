// src/services/volume-client.ts
import { Position } from '../core/types';
import { SERVER_URL } from '../core/config';

interface VolumeResponse {
  // Always empty in v0.2 — kept on the wire only so older server builds that
  // still echo the field don't break JSON.parse. Client never reads it.
  myBlob?: string;
  peerVolumes: Record<string, number>;
}

export class VolumeClient {
  private endpoint: string;

  constructor() {
    this.endpoint = `${SERVER_URL}/compute-volumes`;
  }

  /**
   * v0.2 request: the server reads peer positions from its own room state
   * (populated by `coords` WSS messages from each client), so the request
   * just identifies who we are and where we are. No more peer-to-peer
   * encrypted-blob exchange — see docs/plans/2026-06-02-server-side-positions.md.
   *
   * `allyProximity` opts the caller into hearing teammates by distance (the same
   * falloff as enemies) instead of always-full volume (#22).
   *
   * There is deliberately no camera argument. "Voice on camera" (#36) used to
   * send a `listenPosition` here, which let the request name a point to hear
   * from that peers were never scored against — listening for free. The camera
   * now goes to room state over `coords` and the server reads ours from there,
   * so it cannot be asserted per-request. See signaling.sendCoords.
   */
  async computeVolumes(
    myPosition: Position,
    roomId: string,
    name: string,
    allyProximity: boolean,
  ): Promise<VolumeResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          myPosition: { x: myPosition.x, y: myPosition.y },
          roomId,
          name,
          allyProximity,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Volume API error: ${resp.status}`);
      }

      return resp.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
