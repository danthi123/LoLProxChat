// The fast suite: pure helpers, state machines, and the CV simulation in
// tests/cv, which drives the real TrackingService pipeline over synthesized
// frames. No I/O, no server, no DOM — everything here runs under node.
//
// tests/e2e is a separate config (a server subprocess and a 30s timeout have no
// business in the run that gates every commit).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],
  setupFiles: ['<rootDir>/tests/setup/browser-globals.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
