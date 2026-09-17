// Runs as a jest `setupFiles` entry: before the test framework, and before the
// module registry has loaded anything.
//
// The ordering is load-bearing. src/core/config.ts resolves SERVER_URL from the
// webpack-injected __PROXCHAT_SERVER__ global at MODULE LOAD, so the value has
// to be in place before any import chain reaches it — which is every file that
// touches signaling or volumes.

import { installDomShims } from './dom';
import { installWebAudioFakes } from '../fakes/webaudio';
import { installTaps } from '../harness/tap';

const g = globalThis as any;

// Unlike the fast suite, this one opens REAL sockets to the spawned server, so a
// constants-only stub would not do — it needs the genuine global, which node
// only grew in 22. Fail with the reason rather than a ReferenceError from deep
// inside signaling.ts.
if (typeof g.WebSocket === 'undefined') {
  throw new Error(
    'The end-to-end suite needs a global WebSocket, which node gained in v22. ' +
    'Running node ' + process.version + '. Use node 22 or newer for npm run test:e2e.',
  );
}

// Port 31998: the server's own vitest integration suite owns 31999, and the two
// can run at the same time on a developer's machine.
g.__PROXCHAT_SERVER__ = 'http://127.0.0.1:31998';

installDomShims();
installWebAudioFakes();
installTaps();

// The app logs verbosely by design (core/logging.ts buffers it for the bug
// report). Left on, a two-client session buries the failing assertion. warn and
// error stay: an unexpected one is usually the actual explanation for a failure.
if (!process.env.E2E_VERBOSE) {
  // eslint-disable-next-line no-console
  console.log = () => { /* silenced — set E2E_VERBOSE=1 to restore */ };
}
