import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ControlPlaneStorePort } from "../../domain/control-plane-ports.js";
import type { HumanActionStorePort, IncidentStorePort } from "../../domain/operations-ports.js";
import type { Incident } from "../../domain/operations.js";
import type { IncidentEvidenceBundleBuilderPort } from "../../domain/repair-ports.js";
import type { EvidenceArtifactManifestItem, IncidentEvidenceBundle, RedactionFinding } from "../../domain/repair.js";

export interface ArtifactTextReaderPort {
  inspect(ref: string): { mediaType: string; byteLength?: number; sha256?: string; text?: string; disposition: EvidenceArtifactManifestItem["disposition"]; note?: string };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class SafeLocalArtifactTextReader implements ArtifactTextReaderPort {
  private readonly root: string;
  constructor(root: string, private readonly maxTextBytes = 512_000) { this.root = resolve(root); }

  inspect(ref: string) {
    const path = resolve(ref.startsWith("file:") ? ref.slice(5) : ref);
    if (path !== this.root && !path.startsWith(this.root + "/")) {
      return { mediaType: "application/octet-stream", disposition: "OMITTED_UNSAFE" as const, note: "artifact outside configured evidence root" };
    }
    if (!existsSync(path)) return { mediaType: "application/octet-stream", disposition: "MISSING" as const, note: "artifact missing" };
    const stat = statSync(path);
    if (!stat.isFile()) return { mediaType: "application/octet-stream", disposition: "OMITTED_UNSAFE" as const, note: "artifact is not a file" };
    const lower = path.toLowerCase();
    const mediaType = lower.endsWith(".html") ? "text/html" : lower.endsWith(".json") ? "application/json" : lower.endsWith(".log") || lower.endsWith(".txt") ? "text/plain" : lower.endsWith(".png") ? "image/png" : lower.endsWith(".zip") ? "application/zip" : "application/octet-stream";
    if (!mediaType.startsWith("text/") && mediaType !== "application/json") {
      return { mediaType, byteLength: stat.size, disposition: "OMITTED_BINARY" as const, note: "binary evidence is retained locally but excluded from AI bundle by default" };
    }
    if (stat.size > this.maxTextBytes) {
      return { mediaType, byteLength: stat.size, disposition: "OMITTED_UNSAFE" as const, note: `text artifact exceeds ${this.maxTextBytes} byte AI-bundle limit` };
    }
    const text = readFileSync(path, "utf8");
    return { mediaType, byteLength: stat.size, sha256: sha256(text), text, disposition: "INCLUDED_TEXT" as const };
  }
}

export interface RedactionResult { text: string; findings: readonly RedactionFinding[]; }

export class IncidentTextRedactor {
  readonly version = "w7-redaction-v1";

  redact(input: string): RedactionResult {
    let text = input;
    const counts = new Map<RedactionFinding["kind"], number>();
    const replace = (kind: RedactionFinding["kind"], pattern: RegExp, replacement: string) => {
      let count = 0;
      text = text.replace(pattern, (...args: unknown[]) => { count += 1; return replacement; });
      if (count) counts.set(kind, (counts.get(kind) ?? 0) + count);
    };

    replace("AUTH_HEADER", /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s"'<>]+/gi, "Authorization: [REDACTED]");
    replace("COOKIE", /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "Cookie: [REDACTED]");
    replace("SECRET", /(["']?(?:password|passwd|token|access[_-]?token|refresh[_-]?token|secret|session|api[_-]?key|cookie)["']?\s*[:=]\s*)["']?[^\s,"'<>}]+["']?/gi, "$1[REDACTED]");
    replace("QUERY_SECRET", /([?&](?:token|access_token|auth|key|secret|session)=)[^&#\s]+/gi, "$1[REDACTED]");
    replace("HTML_FIELD", /(<input\b[^>]*\b(?:type=["']?(?:password|email|tel)["']?|name=["']?(?:password|token|secret|session)["']?)[^>]*\bvalue=["'])[^"']*(["'])/gi, "$1[REDACTED]$2");
    replace("EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
    replace("HANDLE", /(?<![A-Z0-9._%+-])@[A-Z0-9._]{2,30}\b/gi, "@[REDACTED_HANDLE]");
    replace("PHONE", /(?<!\w)(?:\+?\d[\d .()\/-]{7,}\d)(?!\w)/g, "[REDACTED_PHONE]");
    replace("PATH", /\/(?:home|Users)\/[^\s"'<>]+/g, "/[REDACTED_HOME_PATH]");

    return { text, findings: [...counts.entries()].map(([kind, replacements]) => ({ kind, replacements })) };
  }

  sanitizeUnknown(value: unknown): { value: unknown; findings: readonly RedactionFinding[] } {
    const findings: RedactionFinding[][] = [];
    const visit = (item: unknown): unknown => {
      if (typeof item === "string") {
        const redacted = this.redact(item);
        findings.push([...redacted.findings]);
        return redacted.text;
      }
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === "object") {
        return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, nested]) => {
          const normalizedKey = key.toLowerCase().replaceAll("-", "_");
          if (["authorization", "password", "passwd", "token", "access_token", "refresh_token", "secret", "session", "api_key", "cookie", "set_cookie"].includes(normalizedKey)) {
            findings.push([{ kind: normalizedKey === "authorization" ? "AUTH_HEADER" : normalizedKey.includes("cookie") ? "COOKIE" : "SECRET", replacements: 1 }]);
            return [key, "[REDACTED]"];
          }
          if (["accountid", "account_id", "creatorid", "creator_id", "identityid", "identity_id", "browseridentityid", "browser_identity_id", "intentid", "intent_id", "sourceobservationid", "source_observation_id", "externalobjectid", "external_object_id"].includes(normalizedKey)) {
            findings.push([{ kind: "IDENTIFIER", replacements: 1 }]);
            return [key, "[REDACTED_IDENTIFIER]"];
          }
          return [key, visit(nested)];
        }));
      }
      return item;
    };
    return { value: visit(value), findings: combineFindings(findings) };
  }
}

type EvidenceStore = IncidentStorePort & ControlPlaneStorePort & HumanActionStorePort;

function combineFindings(items: readonly (readonly RedactionFinding[])[]): readonly RedactionFinding[] {
  const map = new Map<RedactionFinding["kind"], number>();
  for (const findings of items) for (const item of findings) map.set(item.kind, (map.get(item.kind) ?? 0) + item.replacements);
  return [...map.entries()].map(([kind, replacements]) => ({ kind, replacements }));
}

export class IncidentEvidenceBundleBuilder implements IncidentEvidenceBundleBuilderPort {
  constructor(
    private readonly store: EvidenceStore,
    private readonly artifactReader: ArtifactTextReaderPort,
    private readonly redactor = new IncidentTextRedactor()
  ) {}

  build(incident: Incident, params: { capturedAt: string; releaseSha: string; adapterVersion: string }): IncidentEvidenceBundle {
    const events = incident.scope.intentId ? this.store.listEvents("publication_intent", incident.scope.intentId) : [];
    const humanActions = this.store.listHumanActions(incident.scope.intentId, incident.incidentId);
    const context = {
      incident: {
        kind: incident.kind, severity: incident.severity, title: incident.title, summary: incident.summary,
        status: incident.status, openedAt: incident.openedAt, lastObservedAt: incident.lastObservedAt,
        occurrenceCount: incident.occurrenceCount, scope: incident.scope, metadata: incident.metadata
      },
      stateEvents: events.map((event) => ({ eventType: event.eventType, occurredAt: event.occurredAt, fromState: event.fromState, toState: event.toState, payload: event.payload })),
      humanActions: humanActions.map((item) => ({ kind: item.kind, occurredAt: item.occurredAt, operatorId: "[OPERATOR]", note: item.note, payload: item.payload }))
    };
    const sanitizedContext = this.redactor.sanitizeUnknown(context);
    const artifactFindings: RedactionFinding[][] = [];
    const artifacts: EvidenceArtifactManifestItem[] = [];
    for (const ref of incident.evidenceRefs) {
      const inspected = this.artifactReader.inspect(ref);
      if (inspected.disposition === "INCLUDED_TEXT" && inspected.text !== undefined) {
        const sanitized = this.redactor.redact(inspected.text);
        artifactFindings.push([...sanitized.findings]);
        const item: EvidenceArtifactManifestItem = { ref: stableArtifactRef(ref), disposition: "INCLUDED_TEXT", mediaType: inspected.mediaType, sanitizedText: sanitized.text };
        if (inspected.byteLength !== undefined) Object.assign(item, { byteLength: inspected.byteLength });
        if (inspected.sha256 !== undefined) Object.assign(item, { sha256: inspected.sha256 });
        artifacts.push(item);
      } else {
        const item: EvidenceArtifactManifestItem = { ref: stableArtifactRef(ref), disposition: inspected.disposition, mediaType: inspected.mediaType };
        if (inspected.byteLength !== undefined) Object.assign(item, { byteLength: inspected.byteLength });
        if (inspected.sha256 !== undefined) Object.assign(item, { sha256: inspected.sha256 });
        if (inspected.note !== undefined) Object.assign(item, { note: inspected.note });
        artifacts.push(item);
      }
    }
    const capturedAt = new Date(params.capturedAt).toISOString();
    const bundleSeed = `${incident.incidentId}|${capturedAt}|${params.releaseSha}|${params.adapterVersion}|${JSON.stringify(sanitizedContext.value)}|${JSON.stringify(artifacts)}`;
    return {
      bundleId: `bundle:${sha256(bundleSeed).slice(0, 24)}`,
      incidentId: incident.incidentId,
      capturedAt,
      releaseSha: params.releaseSha,
      adapterVersion: params.adapterVersion,
      redactionPolicyVersion: this.redactor.version,
      incidentKind: incident.kind,
      incidentSummary: this.redactor.redact(incident.summary).text,
      sanitizedContext: sanitizedContext.value as Readonly<Record<string, unknown>>,
      artifacts,
      redactionFindings: combineFindings([[...sanitizedContext.findings], ...artifactFindings])
    };
  }
}

function stableArtifactRef(ref: string): string {
  return `artifact:${sha256(ref).slice(0, 20)}`;
}
