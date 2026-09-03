import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserProfileLock, BrowserProfileLockPort } from "../../domain/browser-identity-ports.js";
import type { Instant } from "../../domain/model.js";
import type { LeaseStorePort } from "../../domain/control-plane-ports.js";

export class BrowserProfileLockedError extends Error {}
export class UnsafeProfilePathError extends Error {}

export class BrowserProfileDirectoryResolver {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  resolve(profileKey: string): string {
    if (!profileKey || profileKey.includes("..") || profileKey.startsWith("/") || profileKey.startsWith("\\")) {
      throw new UnsafeProfilePathError(`Unsafe browser profile key: ${profileKey}`);
    }
    const candidate = resolve(this.root, profileKey);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${sep}`)) {
      throw new UnsafeProfilePathError(`Browser profile escaped configured root: ${profileKey}`);
    }
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    return candidate;
  }
}

interface ProfileLockFile {
  identityId: string;
  ownerId: string;
  acquiredAt: string;
  /** Owning process. Absent in locks written before staleness detection existed. */
  pid?: number;
}

/** A process that no longer exists cannot still be using the profile. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(path: string): ProfileLockFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProfileLockFile;
  } catch {
    return null;
  }
}

/**
 * Whether an existing lock is provably abandoned.
 *
 * Only a dead owner counts. A live owner keeps the lock no matter how old it is, because a
 * legitimate operator login can sit at a browser for the better part of an hour -- an age-based
 * rule would steal the profile out from under it. Locks with no recorded pid, or whose file
 * cannot be parsed, are also reclaimable: they predate this check or were written torn, and in
 * both cases no live process can be proven to hold them.
 */
function lockIsStale(path: string): boolean {
  const existing = readLockFile(path);
  if (!existing) return true;
  if (typeof existing.pid !== "number") return true;
  return !processAlive(existing.pid);
}

export class FileBrowserProfileLockAdapter implements BrowserProfileLockPort {
  constructor(private readonly resolver: BrowserProfileDirectoryResolver) {}

  acquire(identity: BrowserIdentity, ownerId: string, now: Instant): BrowserProfileLock {
    const profileDirectory = this.resolver.resolve(identity.profileKey);
    const lockPath = `${profileDirectory}.flerdvision.lock`;
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      // A crashed or killed run never reaches release(), and heartbeat is a no-op, so without
      // this the profile stays locked forever and the only recovery is deleting state by hand.
      if (!lockIsStale(lockPath)) {
        const holder = readLockFile(lockPath);
        throw new BrowserProfileLockedError(
          `Browser profile ${identity.identityId} is already locked by ${holder?.ownerId ?? "another run"}` +
          `${holder?.pid ? ` (pid ${holder.pid}, since ${holder.acquiredAt})` : ""}. Refusing concurrent profile use.`,
          { cause: error }
        );
      }
      rmSync(lockPath, { force: true });
      try {
        fd = openSync(lockPath, "wx", 0o600);
      } catch (retryError) {
        throw new BrowserProfileLockedError(
          `Browser profile ${identity.identityId} is already locked. Refusing concurrent profile use.`,
          { cause: retryError }
        );
      }
    }
    writeFileSync(fd, JSON.stringify({ identityId: identity.identityId, ownerId, acquiredAt: new Date(now).toISOString(), pid: process.pid }), "utf8");
    closeSync(fd);

    let released = false;
    return {
      identityId: identity.identityId,
      ownerId,
      heartbeat(_now: Instant) {},
      release() {
        if (released) return;
        released = true;
        rmSync(lockPath, { force: true });
      }
    };
  }
}


export class DurableBrowserProfileLockAdapter implements BrowserProfileLockPort {
  constructor(
    private readonly leases: LeaseStorePort,
    private readonly local: BrowserProfileLockPort,
    private readonly ttlSeconds = 14_400,
    /** A living holder proves it is alive this often; silence past the store's stale bound frees the lease. */
    private readonly heartbeatIntervalMs = 60_000
  ) {}

  acquire(identity: BrowserIdentity, ownerId: string, now: Instant): BrowserProfileLock {
    const resourceKey = `browser_identity:${identity.identityId}`;
    const actor = { type: "operator" as const, id: ownerId };
    const durable = this.leases.acquireLease(resourceKey, ownerId, now, this.ttlSeconds, actor);
    if (!durable) throw new BrowserProfileLockedError(`Browser identity ${identity.identityId} has an active durable lease`);

    let localLock: BrowserProfileLock;
    try {
      localLock = this.local.acquire(identity, ownerId, now);
    } catch (error) {
      this.leases.releaseLease(resourceKey, ownerId, now, actor);
      throw error;
    }

    let released = false;
    // Runs do not heartbeat on their own; the lock does it for them so a live run keeps its
    // lease fresh and a killed one goes silent -- exactly the signal the store's takeover reads.
    const pulse = setInterval(() => {
      if (released) return;
      try { this.leases.heartbeatLease(resourceKey, ownerId, new Date().toISOString(), this.ttlSeconds, actor); } catch { /* the next explicit heartbeat reports the loss */ }
    }, this.heartbeatIntervalMs);
    const timer = pulse as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") timer.unref();
    return {
      identityId: identity.identityId,
      ownerId,
      heartbeat: (heartbeatAt: Instant) => {
        if (released) throw new BrowserProfileLockedError(`Browser profile lock ${identity.identityId} is already released`);
        localLock.heartbeat(heartbeatAt);
        const refreshed = this.leases.heartbeatLease(resourceKey, ownerId, heartbeatAt, this.ttlSeconds, actor);
        if (!refreshed) throw new BrowserProfileLockedError(`Lost durable lease for browser identity ${identity.identityId}`);
      },
      release: () => {
        if (released) return;
        released = true;
        clearInterval(pulse);
        try {
          localLock.release();
        } finally {
          this.leases.releaseLease(resourceKey, ownerId, new Date().toISOString(), actor);
        }
      }
    };
  }
}
