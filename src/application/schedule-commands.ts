import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWorkspaceSpec, type WorkspaceChannelFormatSpec, type WorkspaceChannelSpec, type WorkspaceSpecV1 } from "../domain/workspace-spec.js";

export class ScheduleCommandError extends Error {}

export interface ScheduleTargetView {
  channelKey: string;
  channelName: string;
  platform: string;
  format: string;
  times: readonly string[];
  capacity: number;
}

export interface ScheduleMutationResult extends ScheduleTargetView {
  changed: boolean;
  beforeTimes: readonly string[];
}

export interface ScheduleCommandApplyPort {
  apply(specPath: string): Promise<void> | void;
}

interface RawFormat extends Record<string, unknown> { type?: unknown; times?: unknown; frequencyPerDay?: unknown; }
interface RawChannel extends Record<string, unknown> { key?: unknown; name?: unknown; platform?: unknown; formats?: unknown; }
interface RawSpec extends Record<string, unknown> { channels?: unknown; }

function localTime(value: string): string {
  const normalized = value.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) throw new ScheduleCommandError(`Ungültige Uhrzeit „${value}“. Erwartet wird HH:mm.`);
  return normalized;
}

function minutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  return hours! * 60 + mins!;
}

function canonicalTimes(values: readonly string[]): string[] {
  const normalized = values.map(localTime);
  if (new Set(normalized).size !== normalized.length) throw new ScheduleCommandError("Ein Slot darf nicht doppelt vorkommen.");
  return [...normalized].sort((a, b) => minutes(a) - minutes(b));
}

function standardTimes(perDay: number): string[] {
  const presets: Readonly<Record<number, readonly string[]>> = {
    1: ["18:00"],
    2: ["12:00", "19:00"],
    3: ["10:00", "15:00", "20:00"],
    4: ["09:00", "12:00", "16:00", "20:00"]
  };
  if (presets[perDay]) return [...presets[perDay]!];
  const start = 9 * 60;
  const end = 21 * 60;
  const step = perDay === 1 ? 0 : (end - start) / (perDay - 1);
  return Array.from({ length: perDay }, (_item, index) => {
    const value = Math.round((start + index * step) / 5) * 5;
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  });
}

function distanceToNearest(candidate: string, existing: readonly string[]): number {
  if (existing.length === 0) return Number.POSITIVE_INFINITY;
  const value = minutes(candidate);
  return Math.min(...existing.map((slot) => Math.abs(value - minutes(slot))));
}

function expandCapacity(existing: readonly string[], desired: number): string[] {
  const current = canonicalTimes(existing);
  if (!Number.isInteger(desired) || desired < 1 || desired > 12) throw new ScheduleCommandError("Kapazität muss zwischen 1 und 12 Posts pro Tag liegen.");
  if (desired < current.length) {
    throw new ScheduleCommandError(`Es existieren bereits ${current.length} Slots. Zum Verkleinern bitte Slots explizit mit schedule remove oder schedule set auswählen.`);
  }
  if (desired === current.length) return current;

  const output = [...current];
  const preferred = standardTimes(desired);
  while (output.length < desired) {
    let candidates = preferred.filter((time) => !output.includes(time));
    if (candidates.length === 0) {
      candidates = Array.from({ length: 145 }, (_item, index) => {
        const value = 9 * 60 + index * 5;
        return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
      }).filter((time) => !output.includes(time));
    }
    candidates.sort((a, b) => distanceToNearest(b, output) - distanceToNearest(a, output) || minutes(a) - minutes(b));
    const next = candidates[0];
    if (!next) throw new ScheduleCommandError("Keine zusätzliche sichere Slot-Zeit verfügbar.");
    output.push(next);
    output.sort((a, b) => minutes(a) - minutes(b));
  }
  return output;
}

function shortKey(key: string): string {
  return key.toLocaleLowerCase("en-US").replace(/^(instagram|tiktok|youtube)-/, "");
}

function splitTarget(target: string): { channel: string; format?: string } {
  const normalized = target.trim();
  if (!normalized) throw new ScheduleCommandError("Kanal fehlt.");
  const separator = normalized.includes("/") ? "/" : normalized.includes(":") ? ":" : undefined;
  if (!separator) return { channel: normalized };
  const [channel, format, ...rest] = normalized.split(separator);
  if (!channel?.trim() || !format?.trim() || rest.length > 0) throw new ScheduleCommandError(`Ungültiges Ziel „${target}“. Beispiel: instagram oder instagram/reel.`);
  return { channel: channel.trim(), format: format.trim() };
}

function rawSpec(value: unknown): RawSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScheduleCommandError("flerdvision.json ist kein Objekt.");
  return value as RawSpec;
}

function rawChannels(spec: RawSpec): RawChannel[] {
  if (!Array.isArray(spec.channels)) throw new ScheduleCommandError("flerdvision.json enthält keine Kanäle.");
  return spec.channels as RawChannel[];
}

function rawFormats(channel: RawChannel): RawFormat[] {
  if (!Array.isArray(channel.formats)) throw new ScheduleCommandError("Der Kanal enthält keine Formate.");
  return channel.formats as RawFormat[];
}

function writeAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

function cloneRaw<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface ResolvedTarget {
  spec: WorkspaceSpecV1;
  channel: WorkspaceChannelSpec;
  format: WorkspaceChannelFormatSpec;
  channelIndex: number;
  formatIndex: number;
}

/**
 * The single product service for schedule changes. CLI and Telegram call this same service.
 * It edits only the canonical flerdvision.json; derived runtime configuration is produced by the
 * injected apply step. A failed apply restores the exact previous JSON and best-effort reapplies it.
 */
export class ScheduleCommandService {
  private readonly specPath: string;

  constructor(specPath: string, private readonly applier?: ScheduleCommandApplyPort) {
    this.specPath = resolve(specPath);
  }

  show(): readonly ScheduleTargetView[] {
    const { spec } = this.read();
    return spec.channels.flatMap((channel) => channel.formats.map((format) => this.view(channel, format)));
  }

  async add(target: string, time: string): Promise<ScheduleMutationResult> {
    const resolved = this.resolve(target);
    return await this.commit(resolved, canonicalTimes([...resolved.format.times, localTime(time)]));
  }

  async remove(target: string, time: string): Promise<ScheduleMutationResult> {
    const resolved = this.resolve(target);
    const slot = localTime(time);
    if (!resolved.format.times.includes(slot)) throw new ScheduleCommandError(`${slot} ist für ${resolved.channel.name} nicht eingetragen.`);
    if (resolved.format.times.length === 1) throw new ScheduleCommandError("Der letzte Slot kann nicht entfernt werden. Verwende pause/stopp, wenn der Kanal nicht posten soll.");
    return await this.commit(resolved, resolved.format.times.filter((item) => item !== slot));
  }

  async set(target: string, times: readonly string[]): Promise<ScheduleMutationResult> {
    if (times.length === 0) throw new ScheduleCommandError("Mindestens ein Slot ist erforderlich.");
    if (times.length > 12) throw new ScheduleCommandError("Maximal 12 Slots pro Tag sind erlaubt.");
    return await this.commit(this.resolve(target), canonicalTimes(times));
  }

  async capacity(target: string, desired: number): Promise<ScheduleMutationResult> {
    const resolved = this.resolve(target);
    return await this.commit(resolved, expandCapacity(resolved.format.times, desired));
  }

  private read(): { raw: RawSpec; rawText: string; spec: WorkspaceSpecV1 } {
    const rawText = readFileSync(this.specPath, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(rawText) as unknown; }
    catch (error) { throw new ScheduleCommandError(`flerdvision.json ist ungültiges JSON: ${error instanceof Error ? error.message : String(error)}`); }
    const raw = rawSpec(parsed);
    return { raw, rawText, spec: parseWorkspaceSpec(raw) };
  }

  private resolve(target: string): ResolvedTarget {
    const { spec } = this.read();
    const wanted = splitTarget(target);
    const token = wanted.channel.toLocaleLowerCase("en-US");
    const matches = spec.channels.map((channel, channelIndex) => ({ channel, channelIndex })).filter(({ channel }) =>
      channel.key.toLocaleLowerCase("en-US") === token ||
      shortKey(channel.key) === token ||
      channel.name.toLocaleLowerCase("en-US") === token ||
      channel.platform.toLocaleLowerCase("en-US") === token ||
      channel.handle.toLocaleLowerCase("en-US") === token
    );
    if (matches.length === 0) throw new ScheduleCommandError(`Unbekannter Kanal „${wanted.channel}“.`);
    if (matches.length > 1) throw new ScheduleCommandError(`„${wanted.channel}“ ist mehrdeutig. Verwende den vollständigen Kanal-Key.`);
    const { channel, channelIndex } = matches[0]!;
    let formatIndex = 0;
    if (wanted.format) {
      formatIndex = channel.formats.findIndex((format) => format.type.toLocaleLowerCase("en-US") === wanted.format!.toLocaleLowerCase("en-US"));
      if (formatIndex < 0) throw new ScheduleCommandError(`Format „${wanted.format}“ existiert für ${channel.name} nicht.`);
    } else if (channel.formats.length !== 1) {
      throw new ScheduleCommandError(`${channel.name} hat mehrere Formate. Verwende z. B. ${channel.key}/${channel.formats[0]!.type}.`);
    }
    return { spec, channel, format: channel.formats[formatIndex]!, channelIndex, formatIndex };
  }

  private view(channel: WorkspaceChannelSpec, format: WorkspaceChannelFormatSpec): ScheduleTargetView {
    return {
      channelKey: channel.key,
      channelName: channel.name,
      platform: channel.platform,
      format: format.type,
      times: [...format.times],
      capacity: format.times.length
    };
  }

  private async commit(target: ResolvedTarget, nextTimes: readonly string[]): Promise<ScheduleMutationResult> {
    const { raw, rawText } = this.read();
    const beforeTimes = [...target.format.times];
    const afterTimes = canonicalTimes(nextTimes);
    const changed = JSON.stringify(beforeTimes) !== JSON.stringify(afterTimes);
    const result: ScheduleMutationResult = { ...this.view(target.channel, { ...target.format, times: afterTimes }), changed, beforeTimes };
    if (!changed) return result;

    const candidate = cloneRaw(raw);
    const rawChannel = rawChannels(candidate)[target.channelIndex];
    if (!rawChannel) throw new ScheduleCommandError("Kanalposition hat sich während der Änderung verändert.");
    const rawFormat = rawFormats(rawChannel)[target.formatIndex];
    if (!rawFormat) throw new ScheduleCommandError("Formatposition hat sich während der Änderung verändert.");
    rawFormat.times = afterTimes;
    if (rawFormat.frequencyPerDay !== undefined) rawFormat.frequencyPerDay = afterTimes.length;
    parseWorkspaceSpec(candidate); // fail before any write

    writeAtomic(this.specPath, candidate);
    try {
      await this.applier?.apply(this.specPath);
    } catch (error) {
      // Restore the exact previous source of truth first. Reapplying it is best effort because a
      // schedule change must never leave the canonical file pointing at an uncompiled rhythm.
      writeFileSync(this.specPath, rawText, { encoding: "utf8", mode: 0o600 });
      try { await this.applier?.apply(this.specPath); } catch {}
      throw new ScheduleCommandError(`Zeitplan wurde nicht übernommen und zurückgerollt: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }
}
