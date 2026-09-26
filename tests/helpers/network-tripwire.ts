/**
 * @fileoverview Vitest `setupFiles` entry that makes any real network access from
 * the suite fail loudly: `globalThis.fetch` rejects, and a TCP connect through
 * `net.Socket` (which `tls`, `http`, and undici all sit on) throws. IPC and
 * Unix-socket path connects still pass, so worker plumbing keeps working. Tests
 * reach an upstream only through an injected `createFetchMock(...).fetch`.
 * @module tests/helpers/network-tripwire
 */

import net from 'node:net';

/** Marker carried by every tripwire error, so a test can assert it fired. */
export const NETWORK_TRIPWIRE = 'network-tripwire';

const describeTarget = (input: unknown): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
};

globalThis.fetch = (input: string | URL | Request) =>
  Promise.reject(
    new Error(
      `${NETWORK_TRIPWIRE}: real fetch of ${describeTarget(input)} blocked — inject a createFetchMock fetch instead.`,
    ),
  );

/** Whether `Socket#connect` arguments name a TCP port rather than an IPC path. */
function isTcpConnect(args: unknown[]): boolean {
  const [first] = args;
  if (Array.isArray(first)) return isTcpConnect(first);
  if (typeof first === 'number') return true;
  if (typeof first === 'string') return /^\d+$/.test(first);
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: unknown; port?: unknown };
    return options.path === undefined && options.port !== undefined;
  }
  return false;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
  if (isTcpConnect(args)) {
    throw new Error(`${NETWORK_TRIPWIRE}: TCP connect blocked — tests must not open sockets.`);
  }
  return (originalConnect as (...rest: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
