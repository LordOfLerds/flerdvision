import type { SourceObservationLookupPort } from "../../domain/ingress-ports.js";
import type { SourceDispositionPort } from "../../domain/ports.js";

export class NoopSourceDispositionAdapter implements SourceDispositionPort {
  async markCompleted(_sourceObservationId: string, _publicationIds: readonly string[]): Promise<void> {}
  async markBlocked(_sourceObservationId: string, _reason: string): Promise<void> {}
}

export interface SourceDispositionEvent {
  kind: "completed" | "blocked";
  sourceObservationId: string;
  publicationIds: readonly string[];
  reason?: string;
}

export class RecordingSourceDispositionAdapter implements SourceDispositionPort {
  readonly events: SourceDispositionEvent[] = [];

  async markCompleted(sourceObservationId: string, publicationIds: readonly string[]): Promise<void> {
    this.events.push({ kind: "completed", sourceObservationId, publicationIds: [...publicationIds] });
  }

  async markBlocked(sourceObservationId: string, reason: string): Promise<void> {
    this.events.push({ kind: "blocked", sourceObservationId, publicationIds: [], reason });
  }
}

export class CompositeSourceDispositionAdapter implements SourceDispositionPort {
  constructor(private readonly adapters: readonly SourceDispositionPort[]) {}

  async markCompleted(sourceObservationId: string, publicationIds: readonly string[]): Promise<void> {
    for (const adapter of this.adapters) await adapter.markCompleted(sourceObservationId, publicationIds);
  }

  async markBlocked(sourceObservationId: string, reason: string): Promise<void> {
    for (const adapter of this.adapters) await adapter.markBlocked(sourceObservationId, reason);
  }
}

export interface WebhookSourceDispositionConfig {
  endpoint: string;
  headers?: Readonly<Record<string, string>>;
}

export class WebhookSourceDispositionAdapter implements SourceDispositionPort {
  constructor(private readonly config: WebhookSourceDispositionConfig) {}

  async markCompleted(sourceObservationId: string, publicationIds: readonly string[]): Promise<void> {
    await this.send({ kind: "completed", sourceObservationId, publicationIds: [...publicationIds] });
  }

  async markBlocked(sourceObservationId: string, reason: string): Promise<void> {
    await this.send({ kind: "blocked", sourceObservationId, publicationIds: [], reason });
  }

  private async send(event: SourceDispositionEvent): Promise<void> {
    const idempotencyKey = `flerdvision:source-disposition:${event.sourceObservationId}:${event.kind}`;
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        ...(this.config.headers ?? {})
      },
      body: JSON.stringify(event)
    });
    if (!response.ok) throw new Error(`Source disposition webhook failed: HTTP ${response.status}`);
  }
}

export interface GoogleDriveWriteClient {
  setAppProperties(fileId: string, properties: Readonly<Record<string, string>>): Promise<void>;
}

export class GoogleDriveAppPropertiesDispositionAdapter implements SourceDispositionPort {
  constructor(
    private readonly lookup: SourceObservationLookupPort,
    private readonly drive: GoogleDriveWriteClient,
    private readonly propertyPrefix = "flerdvision"
  ) {}

  async markCompleted(sourceObservationId: string, publicationIds: readonly string[]): Promise<void> {
    const fileId = this.fileId(sourceObservationId);
    await this.drive.setAppProperties(fileId, {
      [`${this.propertyPrefix}.status`]: "completed",
      [`${this.propertyPrefix}.publication_ids`]: [...publicationIds].sort().join(",")
    });
  }

  async markBlocked(sourceObservationId: string, reason: string): Promise<void> {
    const fileId = this.fileId(sourceObservationId);
    await this.drive.setAppProperties(fileId, {
      [`${this.propertyPrefix}.status`]: "blocked",
      [`${this.propertyPrefix}.reason`]: reason.slice(0, 120)
    });
  }

  private fileId(sourceObservationId: string): string {
    const observation = this.lookup.getSourceObservation(sourceObservationId);
    if (!observation) throw new Error(`Unknown source observation: ${sourceObservationId}`);
    const fileId = observation.observation.metadata.driveFileId;
    if (!fileId) throw new Error(`Source observation ${sourceObservationId} is not a Google Drive file`);
    return fileId;
  }
}
