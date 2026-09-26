/**
 * @fileoverview Canary for the suite's network tripwire, run under the tripwire
 * itself: a real fetch rejects, a TCP connect throws, and an IPC path connect
 * still reaches the OS.
 * @module tests/helpers/network-tripwire.test
 */

import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { NETWORK_TRIPWIRE } from './network-tripwire.js';

describe('network tripwire', () => {
  it('rejects a real fetch', async () => {
    await expect(fetch('https://api.datacite.org/dois')).rejects.toThrow(NETWORK_TRIPWIRE);
  });

  it('throws on a TCP connect in every argument form', () => {
    expect(() => net.connect(443, 'api.datacite.org')).toThrow(NETWORK_TRIPWIRE);
    expect(() => net.connect({ port: 443, host: 'api.datacite.org' })).toThrow(NETWORK_TRIPWIRE);
    expect(() => tls.connect({ port: 443, host: 'doi.org' })).toThrow(NETWORK_TRIPWIRE);
    // Node reads a numeric string as a port; the typings only admit a number.
    const socket = new net.Socket();
    const connect = socket.connect as (...args: unknown[]) => net.Socket;
    expect(() => connect.call(socket, '443', 'api.datacite.org')).toThrow(NETWORK_TRIPWIRE);
  });

  it('lets an IPC path connect through to the OS', async () => {
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const socket = net.connect({ path: '/nonexistent/ipc-canary.sock' });
      socket.on('error', resolve);
    });
    expect(error.code).toBe('ENOENT');
    expect(error.message).not.toContain(NETWORK_TRIPWIRE);
  });
});
