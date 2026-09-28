// Records everything that crosses the wire, in both directions, for both
// clients at once.
//
// Two assertions in this suite can only be made here. The volume tests have to
// read the SERVER's answer rather than the gain that came out the far end,
// because positionTickInner short-circuits while tracking is SCANNING and
// applies 1.0 to allies locally with no request at all — an assertion on the
// applied gain alone is green whether or not the proximity chain exists. And
// the compliance test has to see every inbound frame, since what it is checking
// is that none of them ever carries a coordinate.

interface TappedSocket {
  socket: WebSocket;
  /** The name this socket joined under, once it has sent a `join`. */
  name: string | null;
  inbound: any[];
  outbound: any[];
}

export interface VolumeExchange {
  /** Requesting player, read out of the request body. */
  name: string;
  request: any;
  response: any;
}

const sockets: TappedSocket[] = [];
export const volumeExchanges: VolumeExchange[] = [];

export function installTaps(): void {
  const g = globalThis as any;
  if (g.__proxchatTaps) return;
  g.__proxchatTaps = true;

  const realFetch: typeof fetch = g.fetch.bind(g);
  g.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const response = await realFetch(input, init);
    if (url.endsWith('/compute-volumes')) {
      // clone() so the caller still gets an unread body.
      const body = await response.clone().json().catch(() => null);
      let request: any = null;
      try { request = typeof init?.body === 'string' ? JSON.parse(init.body) : null; } catch { /* keep null */ }
      volumeExchanges.push({ name: request?.name ?? '?', request, response: body });
    }
    return response;
  };

  const RealWebSocket = g.WebSocket;
  class TappedWebSocket extends RealWebSocket {
    constructor(url: string, protocols?: any) {
      super(url, protocols);
      const record: TappedSocket = { socket: this as any, name: null, inbound: [], outbound: [] };
      sockets.push(record);
      (this as any).__record = record;
      this.addEventListener('message', (event: any) => {
        try { record.inbound.push(JSON.parse(event.data)); } catch { record.inbound.push({ unparsed: event.data }); }
      });
    }
    send(data: any): void {
      const record: TappedSocket = (this as any).__record;
      try {
        const msg = JSON.parse(data);
        record.outbound.push(msg);
        if (msg.type === 'join' && typeof msg.name === 'string') record.name = msg.name;
      } catch { record.outbound.push({ unparsed: data }); }
      super.send(data);
    }
  }
  g.WebSocket = TappedWebSocket;
}

/** The most recent socket that joined under `name`. */
export function socketFor(name: string): TappedSocket | undefined {
  for (let i = sockets.length - 1; i >= 0; i--) {
    if (sockets[i].name === name) return sockets[i];
  }
  return undefined;
}

/** Every socket that ever joined under `name`, oldest first. */
export function socketsFor(name: string): TappedSocket[] {
  return sockets.filter((s) => s.name === name);
}

export function inboundFor(name: string): any[] {
  return socketFor(name)?.inbound ?? [];
}

export function volumesFor(name: string): VolumeExchange[] {
  return volumeExchanges.filter((e) => e.name === name);
}

export function lastVolumeFor(name: string): VolumeExchange | undefined {
  const all = volumesFor(name);
  return all[all.length - 1];
}

export function resetTaps(): void {
  sockets.length = 0;
  volumeExchanges.length = 0;
}
