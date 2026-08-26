import { readFileSync } from "node:fs";
import type { Platform, PublicationFormat } from "../../domain/model.js";
import type { PlatformUiSpec, UiActionSpec, UiLocator } from "../../domain/platform-ui.js";

export type PlatformUiCalibrationStatus = "UNVERIFIED" | "CALIBRATED";

export interface PlatformUiSpecEntry {
  specId: string;
  platform: Platform;
  calibrationStatus: PlatformUiCalibrationStatus;
  calibratedAt?: string;
  calibratedBy?: string;
  uiFingerprint?: string;
  spec: PlatformUiSpec;
}

export interface PlatformUiSpecFile {
  schemaVersion: 1;
  specs: readonly PlatformUiSpecEntry[];
}

export class PlatformUiSpecConfigError extends Error {}

const ALLOWED_FORMATS = new Set(["reel", "trial_reel", "tiktok", "short", "story", "unknown"]);
const ALLOWED_CAPABILITIES = new Set([
  "web_video_upload", "caption", "title", "description", "reel", "trial_reel",
  "tiktok_video", "youtube_short", "story", "final_action_boundary"
]);
const ALLOWED_VALUE_SOURCES = new Set(["caption", "title", "description", "hashtags", "media"]);

function locator(value: unknown, path: string, allowCalibrationPlaceholder = false): UiLocator {
  if (!value || typeof value !== "object") throw new PlatformUiSpecConfigError(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  const kind = item.kind;
  if (kind !== "css" && kind !== "text" && kind !== "role" && kind !== "label") {
    throw new PlatformUiSpecConfigError(`${path}.kind is invalid`);
  }
  if (typeof item.value !== "string" || !item.value.trim()) throw new PlatformUiSpecConfigError(`${path}.value is required`);
  if (!allowCalibrationPlaceholder && item.value.includes("__CALIBRATE__")) throw new PlatformUiSpecConfigError(`${path} still contains calibration placeholder`);
  const out: UiLocator = { kind, value: item.value };
  if (typeof item.exact === "boolean") Object.assign(out, { exact: item.exact });
  if (typeof item.role === "string") Object.assign(out, { role: item.role });
  return out;
}

function locatorList(value: unknown, path: string, allowCalibrationPlaceholder = false): readonly UiLocator[] {
  if (!Array.isArray(value)) throw new PlatformUiSpecConfigError(`${path} must be an array`);
  return value.map((item, index) => locator(item, `${path}[${index}]`, allowCalibrationPlaceholder));
}

function action(value: unknown, path: string, allowCalibrationPlaceholder = false): UiActionSpec {
  if (!value || typeof value !== "object") throw new PlatformUiSpecConfigError(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  if (!["click", "fill", "set_file", "wait", "assert_visible"].includes(String(item.action))) {
    throw new PlatformUiSpecConfigError(`${path}.action is invalid`);
  }
  if (typeof item.label !== "string" || !item.label.trim()) throw new PlatformUiSpecConfigError(`${path}.label is required`);
  const out: UiActionSpec = {
    action: item.action as UiActionSpec["action"],
    locators: locatorList(item.locators, `${path}.locators`, allowCalibrationPlaceholder),
    label: item.label
  };
  if (typeof item.valueFrom === "string") {
    if (!ALLOWED_VALUE_SOURCES.has(item.valueFrom)) throw new PlatformUiSpecConfigError(`${path}.valueFrom is invalid`);
    Object.assign(out, { valueFrom: item.valueFrom as UiActionSpec["valueFrom"] });
  }
  if (typeof item.literalValue === "string") Object.assign(out, { literalValue: item.literalValue });
  if (typeof item.optional === "boolean") Object.assign(out, { optional: item.optional });
  if (typeof item.timeoutMs === "number") Object.assign(out, { timeoutMs: item.timeoutMs });
  return out;
}

function actionList(value: unknown, path: string, allowCalibrationPlaceholder = false): readonly UiActionSpec[] {
  if (!Array.isArray(value)) throw new PlatformUiSpecConfigError(`${path} must be an array`);
  return value.map((item, index) => action(item, `${path}[${index}]`, allowCalibrationPlaceholder));
}

function specFromUnknown(value: unknown, path: string, allowCalibrationPlaceholder = false): PlatformUiSpec {
  if (!value || typeof value !== "object") throw new PlatformUiSpecConfigError(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  const platform = item.platform;
  if (platform !== "instagram" && platform !== "tiktok" && platform !== "youtube") throw new PlatformUiSpecConfigError(`${path}.platform is invalid`);
  if (typeof item.bootstrapUrl !== "string" || !/^https:\/\//.test(item.bootstrapUrl)) {
    throw new PlatformUiSpecConfigError(`${path}.bootstrapUrl must be https`);
  }
  if (!Array.isArray(item.supportedFormats)) throw new PlatformUiSpecConfigError(`${path}.supportedFormats must be an array`);
  const supportedFormats = item.supportedFormats.map((format) => {
    const normalized = String(format);
    if (!ALLOWED_FORMATS.has(normalized)) throw new PlatformUiSpecConfigError(`${path}.supportedFormats contains invalid format: ${normalized}`);
    return normalized as PublicationFormat;
  });
  const requiredRaw = item.requiredCapabilities;
  if (!requiredRaw || typeof requiredRaw !== "object") throw new PlatformUiSpecConfigError(`${path}.requiredCapabilities must be an object`);
  const requiredCapabilities: Record<string, readonly string[]> = {};
  for (const [format, capabilities] of Object.entries(requiredRaw as Record<string, unknown>)) {
    if (!Array.isArray(capabilities)) throw new PlatformUiSpecConfigError(`${path}.requiredCapabilities.${format} must be an array`);
    if (!ALLOWED_FORMATS.has(format)) throw new PlatformUiSpecConfigError(`${path}.requiredCapabilities contains invalid format: ${format}`);
    requiredCapabilities[format] = capabilities.map((capability) => {
      const normalized = String(capability);
      if (!ALLOWED_CAPABILITIES.has(normalized)) throw new PlatformUiSpecConfigError(`${path}.requiredCapabilities.${format} contains invalid capability: ${normalized}`);
      return normalized;
    });
  }
  const capRaw = item.capabilityLocators;
  if (!capRaw || typeof capRaw !== "object") throw new PlatformUiSpecConfigError(`${path}.capabilityLocators must be an object`);
  const capabilityLocators: Record<string, readonly UiLocator[]> = {};
  for (const [capability, locators] of Object.entries(capRaw as Record<string, unknown>)) {
    if (!ALLOWED_CAPABILITIES.has(capability)) throw new PlatformUiSpecConfigError(`${path}.capabilityLocators contains invalid capability: ${capability}`);
    capabilityLocators[capability] = locatorList(locators, `${path}.capabilityLocators.${capability}`, allowCalibrationPlaceholder);
  }
  const formatRaw = item.formatActions;
  if (!formatRaw || typeof formatRaw !== "object") throw new PlatformUiSpecConfigError(`${path}.formatActions must be an object`);
  const formatActions: Record<string, readonly UiActionSpec[]> = {};
  for (const [format, actions] of Object.entries(formatRaw as Record<string, unknown>)) {
    if (!ALLOWED_FORMATS.has(format)) throw new PlatformUiSpecConfigError(`${path}.formatActions contains invalid format: ${format}`);
    formatActions[format] = actionList(actions, `${path}.formatActions.${format}`, allowCalibrationPlaceholder);
  }
  return {
    platform,
    bootstrapUrl: item.bootstrapUrl,
    supportedFormats,
    requiredCapabilities: requiredCapabilities as PlatformUiSpec["requiredCapabilities"],
    capabilityLocators: capabilityLocators as PlatformUiSpec["capabilityLocators"],
    preUploadActions: actionList(item.preUploadActions, `${path}.preUploadActions`, allowCalibrationPlaceholder),
    uploadActions: actionList(item.uploadActions, `${path}.uploadActions`, allowCalibrationPlaceholder),
    fieldActions: actionList(item.fieldActions, `${path}.fieldActions`, allowCalibrationPlaceholder),
    formatActions: formatActions as PlatformUiSpec["formatActions"],
    finalActionBoundary: locatorList(item.finalActionBoundary, `${path}.finalActionBoundary`, allowCalibrationPlaceholder)
  };
}

export function parsePlatformUiSpecFile(raw: unknown, requireCalibrated = true): PlatformUiSpecFile {
  if (!raw || typeof raw !== "object") throw new PlatformUiSpecConfigError("Platform UI config must be an object");
  const item = raw as Record<string, unknown>;
  if (item.schemaVersion !== 1) throw new PlatformUiSpecConfigError("Unsupported platform UI config schemaVersion");
  if (!Array.isArray(item.specs)) throw new PlatformUiSpecConfigError("Platform UI config specs must be an array");
  const ids = new Set<string>();
  const specs = item.specs.map((entryValue, index): PlatformUiSpecEntry => {
    if (!entryValue || typeof entryValue !== "object") throw new PlatformUiSpecConfigError(`specs[${index}] must be an object`);
    const entry = entryValue as Record<string, unknown>;
    if (typeof entry.specId !== "string" || !entry.specId.trim()) throw new PlatformUiSpecConfigError(`specs[${index}].specId is required`);
    if (ids.has(entry.specId)) throw new PlatformUiSpecConfigError(`Duplicate specId: ${entry.specId}`);
    ids.add(entry.specId);
    const calibrationStatus = entry.calibrationStatus;
    if (calibrationStatus !== "UNVERIFIED" && calibrationStatus !== "CALIBRATED") throw new PlatformUiSpecConfigError(`specs[${index}].calibrationStatus is invalid`);
    if (requireCalibrated && calibrationStatus !== "CALIBRATED") throw new PlatformUiSpecConfigError(`Spec ${entry.specId} is not calibrated`);
    if (calibrationStatus === "CALIBRATED" && (typeof entry.calibratedAt !== "string" || typeof entry.calibratedBy !== "string")) {
      throw new PlatformUiSpecConfigError(`Calibrated spec ${entry.specId} requires calibratedAt and calibratedBy`);
    }
    const spec = specFromUnknown(entry.spec, `specs[${index}].spec`, calibrationStatus === "UNVERIFIED" && !requireCalibrated);
    if (entry.platform !== spec.platform) throw new PlatformUiSpecConfigError(`Spec ${entry.specId} platform mismatch`);
    const result: PlatformUiSpecEntry = {
      specId: entry.specId,
      platform: spec.platform,
      calibrationStatus,
      spec
    };
    if (typeof entry.calibratedAt === "string") Object.assign(result, { calibratedAt: entry.calibratedAt });
    if (typeof entry.calibratedBy === "string") Object.assign(result, { calibratedBy: entry.calibratedBy });
    if (typeof entry.uiFingerprint === "string") Object.assign(result, { uiFingerprint: entry.uiFingerprint });
    return result;
  });
  return { schemaVersion: 1, specs };
}

export function loadPlatformUiSpecFile(path: string, requireCalibrated = true): PlatformUiSpecFile {
  return parsePlatformUiSpecFile(JSON.parse(readFileSync(path, "utf8")) as unknown, requireCalibrated);
}
