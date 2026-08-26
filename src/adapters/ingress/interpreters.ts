import type { SourceObservation } from "../../domain/model.js";
import type { IngressInterpretation, IngressInterpreterPort } from "../../domain/ports.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAY_PATTERN = /^(0[1-7])_(.+)$/u;

function parsePath(observation: SourceObservation): readonly string[] {
  const raw = observation.metadata.relativePath ?? observation.metadata.path ?? "";
  return raw.split("/").map((part) => part.trim()).filter(Boolean);
}

function plusDays(isoDate: string, days: number): string | undefined {
  if (!ISO_DATE.test(isoDate)) return undefined;
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export interface CurrentDrivePathInterpreterConfig {
  creatorAliases: Readonly<Record<string, string>>;
  unknownCreatorPolicy?: "block" | "ignore";
  daySegmentPattern?: RegExp;
  weekStartBySegment?: Readonly<Record<string, string>>;
  formatFolderHints?: Readonly<Record<string, readonly string[]>>;
}

export class CurrentCreatorWeekDayPathInterpreter implements IngressInterpreterPort {
  constructor(private readonly config: CurrentDrivePathInterpreterConfig) {}

  async interpret(observation: SourceObservation): Promise<IngressInterpretation> {
    const segments = parsePath(observation);
    if (segments.length < 2) {
      return { observationId: observation.observationId, decision: "block", reason: "source_path_too_shallow" };
    }
    const creatorSegment = segments[0];
    if (!creatorSegment) {
      return { observationId: observation.observationId, decision: "block", reason: "creator_segment_missing" };
    }
    const creatorId = this.config.creatorAliases[creatorSegment];
    if (!creatorId) {
      return {
        observationId: observation.observationId,
        decision: this.config.unknownCreatorPolicy === "ignore" ? "ignore" : "block",
        reason: `unknown_creator_alias:${creatorSegment}`
      };
    }

    const dayPattern = this.config.daySegmentPattern ?? DEFAULT_DAY_PATTERN;
    let dayIndex: number | undefined;
    let dayPosition: number | undefined;
    for (let i = 1; i < segments.length - 1; i += 1) {
      const match = dayPattern.exec(segments[i] ?? "");
      dayPattern.lastIndex = 0;
      if (match) {
        const numeric = Number(match[1]);
        if (numeric >= 1 && numeric <= 7) {
          dayIndex = numeric - 1;
          dayPosition = i;
          break;
        }
      }
    }
    if (dayIndex === undefined || dayPosition === undefined) {
      return { observationId: observation.observationId, decision: "block", reason: "day_folder_not_found" };
    }

    let scheduledBusinessDate = observation.metadata.businessDate;
    if (scheduledBusinessDate && !ISO_DATE.test(scheduledBusinessDate)) {
      return { observationId: observation.observationId, decision: "block", reason: "invalid_business_date_metadata" };
    }
    if (!scheduledBusinessDate) {
      const metadataWeekStart = observation.metadata.weekStartDate;
      if (metadataWeekStart) scheduledBusinessDate = plusDays(metadataWeekStart, dayIndex);
    }
    if (!scheduledBusinessDate) {
      const weekSegment = segments[dayPosition - 1];
      const configuredWeekStart = weekSegment ? this.config.weekStartBySegment?.[weekSegment] : undefined;
      if (configuredWeekStart) scheduledBusinessDate = plusDays(configuredWeekStart, dayIndex);
    }

    const formatHints = new Set<string>();
    if (this.config.formatFolderHints) {
      for (const segment of segments.slice(dayPosition + 1, -1)) {
        const hints = this.config.formatFolderHints[segment.toLocaleLowerCase("de-AT")];
        for (const hint of hints ?? []) formatHints.add(hint);
      }
    }

    const result: IngressInterpretation = {
      observationId: observation.observationId,
      decision: "accept",
      creatorId
    };
    if (scheduledBusinessDate) Object.assign(result, { scheduledBusinessDate });
    if (formatHints.size > 0) Object.assign(result, { formatHints: [...formatHints].sort() });
    return result;
  }
}

export interface MetadataFieldInterpreterConfig {
  creatorField?: string;
  businessDateField?: string;
  formatHintsField?: string;
  allowedCreatorIds?: ReadonlySet<string>;
}

export class MetadataFieldIngressInterpreter implements IngressInterpreterPort {
  constructor(private readonly config: MetadataFieldInterpreterConfig = {}) {}

  async interpret(observation: SourceObservation): Promise<IngressInterpretation> {
    const creatorField = this.config.creatorField ?? "creatorId";
    const businessDateField = this.config.businessDateField ?? "businessDate";
    const formatHintsField = this.config.formatHintsField ?? "formatHints";
    const creatorId = observation.metadata[creatorField];
    if (!creatorId) {
      return { observationId: observation.observationId, decision: "block", reason: `missing_metadata:${creatorField}` };
    }
    if (this.config.allowedCreatorIds && !this.config.allowedCreatorIds.has(creatorId)) {
      return { observationId: observation.observationId, decision: "block", reason: `unknown_creator_id:${creatorId}` };
    }
    const businessDate = observation.metadata[businessDateField];
    if (businessDate && !ISO_DATE.test(businessDate)) {
      return { observationId: observation.observationId, decision: "block", reason: "invalid_business_date_metadata" };
    }
    const rawHints = observation.metadata[formatHintsField];
    const hints = rawHints?.split(",").map((value) => value.trim()).filter(Boolean);
    const result: IngressInterpretation = { observationId: observation.observationId, decision: "accept", creatorId };
    if (businessDate) Object.assign(result, { scheduledBusinessDate: businessDate });
    if (hints && hints.length > 0) Object.assign(result, { formatHints: hints });
    return result;
  }
}
