import type { ChildProcess } from 'node:child_process';

export default async function globalTeardown(): Promise<void> {
  const child: ChildProcess | undefined = (globalThis as any).__PROXCHAT_SERVER_PROC__;
  if (!child) return;
  // SIGKILL rather than SIGTERM: the server holds an open WebSocketServer and a
  // couple of unref'd intervals, and nothing in the run needs a clean shutdown.
  child.kill('SIGKILL');
}
