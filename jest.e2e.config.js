// The slow suite: two Orchestrator-level clients against the REAL built server,
// spawned as a subprocess for the run.
//
// A separate config rather than a jest `projects` entry, because this run needs
// globalSetup/globalTeardown, its own setupFiles, a 30s timeout and a single
// worker — and because `npm test` vs `npm run test:e2e` is a clearer thing to
// hand a contributor than `--selectProjects`.
//
// testEnvironment is 'node', NOT jsdom. Under jsdom `require('ws')` resolves to
// the browser shim that throws by design, and the jsdom AbortSignal that
// volume-client.ts creates is rejected by node's fetch as a foreign realm's
// object — which orchestrator.ts swallows, turning every proximity assertion
// into an opaque timeout. The DOM surface actually needed is shimmed in
// tests/e2e/setup/dom.ts.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests/e2e'],
  testMatch: ['**/*.e2e.test.ts'],
  globalSetup: '<rootDir>/tests/e2e/setup/global-setup.ts',
  globalTeardown: '<rootDir>/tests/e2e/setup/global-teardown.ts',
  setupFiles: ['<rootDir>/tests/e2e/setup/env.ts'],
  // Registered here rather than with jest.mock() from a helper: jest.mock is
  // hoisted only inside the file that calls it, so an imported helper would
  // silently no-op once the module under test had captured the real namespace.
  moduleNameMapper: {
    '^@tauri-apps/api/core$': '<rootDir>/tests/e2e/fakes/tauri-core.ts',
    '^@tauri-apps/api/event$': '<rootDir>/tests/e2e/fakes/tauri-event.ts',
  },
  // One worker: the clients share one server, one port and one process-global
  // localStorage (see audio-prefs.ts), so parallel files would interfere.
  maxWorkers: 1,
  testTimeout: 30000,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
