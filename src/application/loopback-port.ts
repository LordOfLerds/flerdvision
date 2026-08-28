import { connect } from "node:net";

/**
 * Whether something already answers on a loopback port.
 *
 * Binding 127.0.0.1:<port> succeeds on macOS even when another process holds 0.0.0.0:<port>, so
 * a second listener starts without error and the two silently split incoming connections. For an
 * OAuth callback that means the browser's redirect can land in the wrong process and the flow
 * simply never completes -- no error anywhere, just a timeout. Probing first turns that into a
 * refusal that names the port.
 */
export async function loopbackPortInUse(port: number, host = "127.0.0.1", timeoutMs = 300): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolvePromise(inUse);
    };
    const socket = connect({ port, host });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export function portInUseMessage(port: number, flagName: string): string {
  return `Loopback port ${port} is already in use by another process. ` +
    `Two listeners would split the callback and the flow would time out without an error. ` +
    `Stop that process or choose a different port with ${flagName} <port>.`;
}
