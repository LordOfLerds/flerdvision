import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserScreencastPort, BrowserScreencastStartOptions } from "../../domain/browser-identity-ports.js";
import { resolveFfmpegExecutablePath } from "../media/resolve-ffmpeg.js";

/**
 * An optional MP4 of the final moments of a browser run leg, written next to the screenshots the
 * same leg already produces. It is evidence for a human, never input to a decision: every path
 * here fails open, so a broken or absent recorder can only cost the recording, never the run.
 */

/** The CDP surface the recorder needs. The real page client and the test fake both satisfy it. */
export interface ScreencastCdpClient {
  send(method: string, params?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<Record<string, unknown>>;
  on(method: string, handler: (params: Record<string, unknown>) => void): void;
  off(method: string, handler: (params: Record<string, unknown>) => void): void;
}

export const SCREENCAST_DEFAULTS = { maxWidth: 960, quality: 60, fps: 2 } as const;
/** Keep only the part a human needs to understand where a run failed. */
export const SCREENCAST_DIAGNOSTIC_SECONDS = 30;
/** Chromium feeds the screencast from the compositor; everyNthFrame is a divisor of that rate. */
export const SCREENCAST_SOURCE_FPS = 30;
/** ffmpeg must not be able to hang a run leg's teardown; assembly is bounded like every other step. */
export const SCREENCAST_ASSEMBLY_TIMEOUT_MS = 120_000;

export function everyNthFrameFor(fps: number): number {
  const wanted = Number.isFinite(fps) && fps > 0 ? fps : SCREENCAST_DEFAULTS.fps;
  return Math.max(1, Math.round(SCREENCAST_SOURCE_FPS / wanted));
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return safe || "screencast";
}
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function defaultLog(message: string): void { console.error(message); }

function runFfmpeg(executable: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (code: number): void => { if (settled) return; settled = true; clearTimeout(timer); resolveExit(code); };
    const child = spawn(executable, args, { stdio: "ignore" });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, SCREENCAST_ASSEMBLY_TIMEOUT_MS);
    child.once("error", () => finish(-1));
    child.once("exit", (code) => finish(typeof code === "number" ? code : -1));
  });
}

interface ActiveRecording {
  frameDir: string;
  outputPath: string;
  fps: number;
  frames: number;
  maxFrames: number;
  framePaths: string[];
  handler: (params: Record<string, unknown>) => void;
}

function normalizeRetainedFrames(state: ActiveRecording): void {
  state.framePaths.forEach((path, index) => {
    const target = join(state.frameDir, `frame-${String(index).padStart(6, "0")}.jpg`);
    if (path !== target) renameSync(path, target);
  });
}

export class CdpScreencastRecorder implements BrowserScreencastPort {
  private active: ActiveRecording | null = null;
  private nested = 0;

  constructor(private readonly client: ScreencastCdpClient, private readonly log: (message: string) => void = defaultLog) {}

  /**
   * Starts a jpeg screencast. Frames are kept as a rolling diagnostic tail instead of retaining
   * the whole browser run. A nested start is deliberately a no-op: restarting would split the
   * outer file, and the outer leg is the one that owns the session.
   */
  async start(options: BrowserScreencastStartOptions): Promise<void> {
    if (this.active) { this.nested += 1; return; }
    const fps = options.fps ?? SCREENCAST_DEFAULTS.fps;
    let frameDir = "";
    try {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 });
      frameDir = mkdtempSync(join(options.dir, `.screencast-${safeSegment(options.name)}-`));
      const state: ActiveRecording = {
        frameDir,
        outputPath: join(options.dir, `${safeSegment(options.name)}.mp4`),
        fps,
        frames: 0,
        maxFrames: Math.max(1, Math.ceil(fps * SCREENCAST_DIAGNOSTIC_SECONDS)),
        framePaths: [],
        handler: () => {}
      };
      state.handler = (params) => {
        const data = typeof params.data === "string" ? params.data : "";
        if (data) {
          try {
            const framePath = join(state.frameDir, `frame-${String(state.frames).padStart(6, "0")}.jpg`);
            writeFileSync(framePath, data, { encoding: "base64", mode: 0o600 });
            state.frames += 1;
            state.framePaths.push(framePath);
            while (state.framePaths.length > state.maxFrames) {
              const stale = state.framePaths.shift();
              if (stale) { try { rmSync(stale, { force: true }); } catch {} }
            }
          } catch {}
        }
        // Without the acknowledgement Chromium sends exactly one frame and then goes quiet, so
        // the ack matters more than the frame that triggered it: it is sent either way.
        const sessionId = params.sessionId;
        if (sessionId !== undefined) void this.client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      };
      this.client.on("Page.screencastFrame", state.handler);
      this.active = state;
      await this.client.send("Page.startScreencast", {
        format: "jpeg",
        quality: options.quality ?? SCREENCAST_DEFAULTS.quality,
        maxWidth: options.maxWidth ?? SCREENCAST_DEFAULTS.maxWidth,
        everyNthFrame: everyNthFrameFor(fps)
      });
    } catch (error) {
      const state = this.active;
      this.active = null;
      if (state) { try { this.client.off("Page.screencastFrame", state.handler); } catch {} }
      if (frameDir) { try { rmSync(frameDir, { recursive: true, force: true }); } catch {} }
      this.log(`screencast: not recording (${reason(error)}); the run is unaffected`);
    }
  }

  /** Stops the screencast and assembles only the retained diagnostic tail. */
  async stop(): Promise<string | null> {
    if (this.nested > 0) { this.nested -= 1; return null; }
    const state = this.active;
    if (!state) return null;
    this.active = null;
    try { this.client.off("Page.screencastFrame", state.handler); } catch {}
    try { await this.client.send("Page.stopScreencast"); } catch {}
    try {
      if (state.framePaths.length === 0) { this.log("screencast: no frames arrived; no recording written"); return null; }
      let ffmpeg: string;
      try {
        ffmpeg = resolveFfmpegExecutablePath();
      } catch (error) {
        this.log(`screencast: ${reason(error)} -- ${state.frames} captured frames discarded, the run is unaffected`);
        return null;
      }
      normalizeRetainedFrames(state);
      const exitCode = await runFfmpeg(ffmpeg, [
        "-y", "-nostdin", "-loglevel", "error",
        "-framerate", String(state.fps),
        "-i", join(state.frameDir, "frame-%06d.jpg"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        state.outputPath
      ]);
      if (exitCode !== 0) { this.log(`screencast: ffmpeg exited with ${exitCode}; no recording written`); return null; }
      return state.outputPath;
    } catch (error) {
      this.log(`screencast: recording could not be assembled (${reason(error)}); the run is unaffected`);
      return null;
    } finally {
      try { rmSync(state.frameDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Recordings are convenience evidence, not durable proof, so they are kept on a short leash: a
 * run prunes stale MP4s (and frame directories a killed process left behind) from the directory
 * it is about to write into.
 */
export function pruneRecordings(dir: string, maxAgeDays = 14, now: number = Date.now()): readonly string[] {
  const removed: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return removed; }
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.endsWith(".mp4") && !entry.startsWith(".screencast-")) continue;
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      if (new Date(stat.mtime.toISOString()).getTime() >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {}
  }
  return removed;
}

export function screencastEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = (env.FLERDVISION_SCREENCAST ?? "").trim().toLocaleLowerCase("en-US");
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Applies a command's default when the operator has not decided; an explicit value always wins. */
export function applyScreencastDefault(env: Record<string, string | undefined>, defaultOn: boolean): void {
  if ((env.FLERDVISION_SCREENCAST ?? "").trim() !== "") return;
  env.FLERDVISION_SCREENCAST = defaultOn ? "1" : "0";
}

export interface RunRecording { stop(): Promise<string | null>; }

/**
 * The single entry point every run leg uses. It answers three questions -- is recording on, can
 * this session record, is there a directory to record into -- and swallows everything else, so
 * no caller has to reason about screencast failures at all.
 */
export async function beginScreencast(
  session: { screencast?: BrowserScreencastPort },
  dir: string | undefined,
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (message: string) => void = defaultLog
): Promise<RunRecording | null> {
  if (!screencastEnabled(env)) return null;
  const recorder = session.screencast;
  if (!recorder || !dir?.trim()) return null;
  try {
    pruneRecordings(dir);
    await recorder.start({ dir, name, ...SCREENCAST_DEFAULTS });
  } catch (error) {
    log(`screencast: not recording (${reason(error)}); the run is unaffected`);
    return null;
  }
  return {
    stop: async (): Promise<string | null> => {
      try { return await recorder.stop(); }
      catch (error) { log(`screencast: recording could not be finished (${reason(error)}); the run is unaffected`); return null; }
    }
  };
}