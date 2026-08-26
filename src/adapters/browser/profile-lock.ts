import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
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

export class FileBrowserProfileLockAdapter implements BrowserProfileLockPort {
  constructor(private readonly resolver: BrowserProfileDirectoryResolver) {}

  acquire(identity: BrowserIdentity, ownerId: string, now: Instant): BrowserProfileLock {
    const profileDirectory = this.resolver.resolve(identity.profileKey);
    const lockPath = `${profileDirectory}.flerdvision.lock`;
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      throw new BrowserProfileLockedError(
        `Browser profile ${identity.identityId} is already locked. Refusing concurrent profile use.`,
        { cause: error }
      );
    }
    writeFileSync(fd, JSON.stringify({ identityId: identity.identityId, ownerId, acquiredAt: new Date(now).toISOString() }), "utf8");
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
    private readonly ttlSeconds = 14_400
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
        try {
          localLock.release();
        } finally {
          this.leases.releaseLease(resourceKey, ownerId, new Date().toISOString(), actor);
        }
      }
    };
  }
}
