import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../../domain/distribution-ports.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../../domain/distribution-operations.js";
import { assertOperatingCalendarCatalog, assertRouteCalendarReference } from "../../domain/operating-calendar.js";
import { DEFAULT_SCHEDULING_POLICY } from "../../domain/scheduling.js";
import { assertConfigurationReferentialIntegrity } from "../../application/distribution-config.js";

export class DistributionConfigurationRevisionConflict extends Error {}

const EMPTY: Omit<StoredDistributionConfiguration, "revision" | "updatedAt"> = {
  config: { sources: [], lanes: [], postingProfiles: [], copyProfiles: [], routes: [], activationCursors: [] },
  schedulePolicies: { default: DEFAULT_SCHEDULING_POLICY },
  operatingCalendars: [],
  planningPolicy: {
    contentOrder: "FILENAME_NUMERIC_PREFIX",
    lateArrival: "NEXT_AVAILABLE_SLOT",
    overflow: "BACKLOG_NEXT_DAY"
  },
  runtimePolicy: DEFAULT_DISTRIBUTION_RUNTIME_POLICY
};

function normalize(value: StoredDistributionConfiguration): StoredDistributionConfiguration {
  return {
    ...value,
    operatingCalendars: value.operatingCalendars ?? [],
    runtimePolicy: value.runtimePolicy ?? DEFAULT_DISTRIBUTION_RUNTIME_POLICY
  };
}

function assertStoredIntegrity(value: StoredDistributionConfiguration): void {
  assertConfigurationReferentialIntegrity(value.config);
  const calendars = value.operatingCalendars ?? [];
  assertOperatingCalendarCatalog(calendars, value.schedulePolicies);
  for (const route of value.config.routes) assertRouteCalendarReference(route, calendars);
}

export class JsonDistributionConfigurationStore implements DistributionConfigurationStorePort {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) {
      const initial: StoredDistributionConfiguration = {
        revision: 0,
        updatedAt: new Date(0).toISOString(),
        ...EMPTY
      };
      this.atomicWrite(initial);
    }
  }

  load(): StoredDistributionConfiguration {
    const parsed = normalize(JSON.parse(readFileSync(this.path, "utf8")) as StoredDistributionConfiguration);
    if (!Number.isInteger(parsed.revision) || parsed.revision < 0) throw new Error("Distribution configuration has invalid revision");
    assertStoredIntegrity(parsed);
    return parsed;
  }

  save(next: Omit<StoredDistributionConfiguration, "revision">, expectedRevision: number): StoredDistributionConfiguration {
    const current = this.load();
    if (current.revision !== expectedRevision) {
      throw new DistributionConfigurationRevisionConflict(`Distribution configuration revision changed: expected ${expectedRevision}, current ${current.revision}`);
    }
    const stored: StoredDistributionConfiguration = normalize({
      ...next,
      revision: current.revision + 1,
      updatedAt: new Date(next.updatedAt).toISOString()
    });
    assertStoredIntegrity(stored);
    this.atomicWrite(stored);
    return stored;
  }

  private atomicWrite(value: StoredDistributionConfiguration): void {
    const temp = `${this.path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }
}
