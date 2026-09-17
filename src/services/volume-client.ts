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
   * `listenPosition`, when given, is the point we hear FROM — the camera centre
   * under "voice on camera" (#36). It only affects this response; `myPosition`
   * remains what peers measure their distance to, so the effect is listen-only.
   */
  async computeVolumes(
    myPosition: Position,
    roomId: string,
    name: string,
    allyProximity: boolean,
    listenPosition?: Position | null,
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
          ...(listenPosition
            ? { listenPosition: { x: listenPosition.x, y: listenPosition.y } }
            : {}),
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
