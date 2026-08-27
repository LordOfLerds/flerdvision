import type { SourceObservation } from "../../domain/model.js";
import type { IngressInterpretation, IngressInterpreterPort } from "../../domain/ports.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAY_PATTERN = /^(0[1-7])_(.+)$/u;
const EXPLICIT_ISO_WEEK = /^(\d{4})[-_ ]?(?:KW|W)(\d{2})$/iu;

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

/** Monday of an explicit ISO year/week such as 2026-KW35 or 2026-W35. */
function isoWeekMonday(segment:string):string|undefined{
  const match=EXPLICIT_ISO_WEEK.exec(segment);if(!match)return undefined;
  const year=Number(match[1]),week=Number(match[2]);if(week<1||week>53)return undefined;
  // ISO week 1 contains January 4. Move that date back to Monday, then add whole weeks.
  const jan4=new Date(Date.UTC(year,0,4)),weekday=jan4.getUTCDay()||7;
  const monday=new Date(Date.UTC(year,0,4-(weekday-1)+((week-1)*7)));
  // Validate that the resulting Thursday still belongs to the requested ISO year; this rejects
  // impossible week 53 for years that only contain 52 ISO weeks.
  const thursday=new Date(monday.getTime()+3*86_400_000);
  const thursdayYear=thursday.getUTCFullYear();
  if(thursdayYear!==year&&week===53)return undefined;
  const result=monday.toISOString().slice(0,10);
  // Round-trip week-number validation.
  const d=new Date(`${result}T00:00:00.000Z`),day=d.getUTCDay()||7;
  d.setUTCDate(d.getUTCDate()+4-day);
  const yearStart=new Date(Date.UTC(d.getUTCFullYear(),0,1));
  const calculated=Math.ceil((((d.getTime()-yearStart.getTime())/86_400_000)+1)/7);
  return d.getUTCFullYear()===year&&calculated===week?result:undefined;
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
    if (segments.length < 2) return { observationId: observation.observationId, decision: "block", reason: "source_path_too_shallow" };
    const creatorSegment = segments[0];
    if (!creatorSegment) return { observationId: observation.observationId, decision: "block", reason: "creator_segment_missing" };
    const creatorId = this.config.creatorAliases[creatorSegment];
    if (!creatorId) {
      return { observationId: observation.observationId, decision: this.config.unknownCreatorPolicy === "ignore" ? "ignore" : "block", reason: `unknown_creator_alias:${creatorSegment}` };
    }

    const dayPattern = this.config.daySegmentPattern ?? DEFAULT_DAY_PATTERN;
    let dayIndex: number | undefined;
    let dayPosition: number | undefined;
    for (let i = 1; i < segments.length - 1; i += 1) {
      const match = dayPattern.exec(segments[i] ?? "");dayPattern.lastIndex = 0;
      if (match) {const numeric = Number(match[1]);if (numeric >= 1 && numeric <= 7) {dayIndex = numeric - 1;dayPosition = i;break;}}
    }
    if (dayIndex === undefined || dayPosition === undefined) return { observationId: observation.observationId, decision: "block", reason: "day_folder_not_found" };

    let scheduledBusinessDate = observation.metadata.businessDate;
    if (scheduledBusinessDate && !ISO_DATE.test(scheduledBusinessDate)) return { observationId: observation.observationId, decision: "block", reason: "invalid_business_date_metadata" };
    if (!scheduledBusinessDate) {
      const metadataWeekStart = observation.metadata.weekStartDate;
      if (metadataWeekStart) scheduledBusinessDate = plusDays(metadataWeekStart, dayIndex);
    }
    if (!scheduledBusinessDate) {
      const weekSegment = segments[dayPosition - 1];
      const configuredWeekStart = weekSegment ? this.config.weekStartBySegment?.[weekSegment] : undefined;
      const explicitIsoWeekStart = weekSegment ? isoWeekMonday(weekSegment) : undefined;
      const weekStart=configuredWeekStart??explicitIsoWeekStart;
      if (weekStart) scheduledBusinessDate = plusDays(weekStart, dayIndex);
    }

    const formatHints = new Set<string>();
    if (this.config.formatFolderHints) {
      for (const segment of segments.slice(dayPosition + 1, -1)) {
        const hints = this.config.formatFolderHints[segment.toLocaleLowerCase("de-AT")];
        for (const hint of hints ?? []) formatHints.add(hint);
      }
    }

    const result: IngressInterpretation = { observationId: observation.observationId, decision: "accept", creatorId };
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
    if (!creatorId) return { observationId: observation.observationId, decision: "block", reason: `missing_metadata:${creatorField}` };
    if (this.config.allowedCreatorIds && !this.config.allowedCreatorIds.has(creatorId)) return { observationId: observation.observationId, decision: "block", reason: `unknown_creator_id:${creatorId}` };
    const businessDate = observation.metadata[businessDateField];
    if (businessDate && !ISO_DATE.test(businessDate)) return { observationId: observation.observationId, decision: "block", reason: "invalid_business_date_metadata" };
    const rawHints = observation.metadata[formatHintsField];
    const hints = rawHints?.split(",").map((value) => value.trim()).filter(Boolean);
    const result: IngressInterpretation = { observationId: observation.observationId, decision: "accept", creatorId };
    if (businessDate) Object.assign(result, { scheduledBusinessDate: businessDate });
    if (hints && hints.length > 0) Object.assign(result, { formatHints: hints });
    return result;
  }
}
