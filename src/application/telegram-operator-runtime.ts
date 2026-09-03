import { TelegramChatMessenger } from "../adapters/notify/telegram-messenger.js";
import { TelegramCommandLoop, type TelegramPollReport } from "../adapters/notify/telegram-command-loop.js";
import type { HumanActionStorePort, KillSwitchStorePort } from "../domain/operations-ports.js";
import type { OperatorStatePort } from "../domain/operator-ports.js";
import type { StoredContentAssetRevision } from "../domain/distribution-runtime-ports.js";
import type { HeadlessDoctorReport } from "./headless-status.js";
import { KillSwitchGate, KillSwitchService } from "./operations.js";
import { OperatorCommandService, type OperatorCommandControlReads } from "./operator-commands.js";
import { operatorChannelStatusFromDoctor, type OperatorChannelRef, type OperatorChannelStatus, type OperatorPlanViewStores } from "./operator-plan-view.js";
import { OperatorReportService, type OperatorReportTickResult } from "./operator-reports.js";
import { CompositeOperationalPublishGate, SchedulePauseGate } from "./schedule-pause.js";
import { SessionHealthAlarmService, type SessionHealthAlarmTickResult } from "./session-health-alarm.js";

export interface TelegramOperatorRuntimeOptions {
  env: Record<string, string | undefined>;
  channels: readonly OperatorChannelRef[];
  control: OperatorPlanViewStores["control"] & OperatorCommandControlReads & KillSwitchStorePort & HumanActionStorePort;
  state: { listAssets(): readonly StoredContentAssetRevision[] };
  /** One SqliteOperatorStateStore on the workspace database (pauses + chat state). */
  operatorState: OperatorStatePort;
  doctor: () => HeadlessDoctorReport;
  timeZone: string;
  clock?: () => string;
  fetchImpl?: typeof fetch;
  /** Operational log line; keep it token- and content-free. */
  log?: (line: string) => void;
}

export interface TelegramOperatorTickResult {
  alarm?: SessionHealthAlarmTickResult;
  reports?: OperatorReportTickResult;
  errors: readonly string[];
}

/**
 * Composition root of the interactive operator layer. One instance owns:
 * - the long-polling command loop (/status /plan /doctor /pause /fortsetzen /stopp),
 * - the morning checklist + evening/weekly reports,
 * - the session-health alarm that pauses a channel and calls for a manual re-login.
 *
 * It is constructed from the daemon's already-open stores and NEVER opens a browser, claims an
 * intent or performs any publish step. Its only write powers are: schedule pauses (both ways),
 * kill switches (enable only) and Telegram messages. Wire `publishGate()` into the due worker
 * so pauses take effect; without that the pause is display-only.
 */
export class TelegramOperatorService {
  private readonly reportService: OperatorReportService;
  private readonly alarmService: SessionHealthAlarmService;
  private readonly loop: TelegramCommandLoop;
  private readonly log: (line: string) => void;

  /** Returns undefined when FLERDVISION_TELEGRAM_BOT_TOKEN / _CHAT_ID are not both configured. */
  static fromEnv(options: TelegramOperatorRuntimeOptions): TelegramOperatorService | undefined {
    const botToken = options.env.FLERDVISION_TELEGRAM_BOT_TOKEN;
    const chatId = options.env.FLERDVISION_TELEGRAM_CHAT_ID;
    if (!botToken?.trim() || !chatId?.trim()) return undefined;
    return new TelegramOperatorService(options, botToken.trim(), chatId.trim());
  }

  private constructor(private readonly options: TelegramOperatorRuntimeOptions, botToken: string, chatId: string) {
    this.log = options.log ?? (() => {});
    // The checklist has to name a channel that is not released yet, and only the doctor knows
    // that. It opens the workspace database, so one reading per minute is plenty for a message
    // that changes at most once a cycle; a failing doctor degrades to the last known answer.
    let cached: { atMs: number; value: readonly OperatorChannelStatus[] } | undefined;
    const channelStatus = (): readonly OperatorChannelStatus[] => {
      const atMs = Date.now();
      if (cached && atMs - cached.atMs < 60_000) return cached.value;
      try {
        cached = { atMs, value: operatorChannelStatusFromDoctor(options.doctor()) };
      } catch (error) {
        this.log(`telegram-operator: channel status unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return cached?.value ?? [];
    };
    const stores: OperatorPlanViewStores = { control: options.control, state: options.state, pauses: options.operatorState, channelStatus };
    const messenger = new TelegramChatMessenger({ botToken, chatId, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const commands = new OperatorCommandService({
      channels: options.channels,
      stores: { ...stores, control: options.control },
      pauses: options.operatorState,
      killSwitches: new KillSwitchService(options.control),
      doctor: options.doctor,
      timeZone: options.timeZone,
      ...(options.clock ? { clock: options.clock } : {})
    });
    this.reportService = new OperatorReportService(
      { stores, channels: options.channels, chatState: options.operatorState, messenger },
      { timeZone: options.timeZone, ...(options.clock ? { clock: options.clock } : {}) }
    );
    const remoteScreenUrl = options.env.FLERDVISION_REMOTE_SCREEN_URL;
    this.alarmService = new SessionHealthAlarmService({
      control: options.control,
      channels: options.channels,
      pauses: options.operatorState,
      chatState: options.operatorState,
      messenger,
      ...(remoteScreenUrl?.trim() ? { remoteScreenUrl: remoteScreenUrl.trim() } : {}),
      ...(options.clock ? { clock: options.clock } : {})
    });
    this.loop = new TelegramCommandLoop({
      botToken,
      chatId,
      execute: (text) => commands.execute(text),
      log: this.log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.clock ? { clock: options.clock } : {})
    });
  }

  /**
   * The due worker's operational gate with pauses included: kill switches AND schedule pauses.
   * Pass this wherever a bare KillSwitchGate is wired today.
   */
  publishGate(): CompositeOperationalPublishGate {
    return new CompositeOperationalPublishGate([new KillSwitchGate(this.options.control), new SchedulePauseGate(this.options.operatorState)]);
  }

  /**
   * One daemon-cycle step: session alarm first (pausing precedes any further due work), then
   * checklist/report upkeep. Telegram failures are contained and reported -- a broken chat
   * channel must never break the publishing cycle.
   */
  async tick(now = new Date().toISOString()): Promise<TelegramOperatorTickResult> {
    const errors: string[] = [];
    const result: TelegramOperatorTickResult = { errors };
    try { result.alarm = await this.alarmService.tick(now); }
    catch (error) { errors.push(`alarm: ${error instanceof Error ? error.message : String(error)}`); }
    try { result.reports = await this.reportService.tick(now); }
    catch (error) { errors.push(`reports: ${error instanceof Error ? error.message : String(error)}`); }
    for (const line of errors) this.log(`telegram-operator: ${line}`);
    return result;
  }

  /** Runs the interactive command loop until the signal aborts (start alongside the daemon). */
  async runCommandLoop(signal: { aborted: boolean }): Promise<void> {
    await this.loop.run(signal);
  }

  /** One getUpdates round trip; useful for embedding into an existing cycle or for tests. */
  async pollCommandsOnce(): Promise<TelegramPollReport> {
    return await this.loop.pollOnce();
  }
}
