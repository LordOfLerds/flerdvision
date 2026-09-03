import type { SessionHealthCheck, StoredBrowserIdentity } from "../domain/browser-identity.js";
import type { OperatorChatStatePort, SchedulePauseStorePort } from "../domain/operator-ports.js";
import type { OperatorChannelRef } from "./operator-plan-view.js";
import { germanPlatformLabel, operatorMessageText, renderOperatorMessage } from "./operator-message.js";

export interface SessionHealthAlarmDeps {
  control: {
    listBrowserIdentities(): readonly StoredBrowserIdentity[];
    latestSessionHealth(identityId: string): SessionHealthCheck | null;
  };
  channels: readonly OperatorChannelRef[];
  pauses: SchedulePauseStorePort;
  chatState: OperatorChatStatePort;
  messenger: { sendMessage(text: string): Promise<string> };
  /** noVNC/remote-screen URL for the re-login (env FLERDVISION_REMOTE_SCREEN_URL). */
  remoteScreenUrl?: string;
  clock?: () => string;
}

export interface SessionHealthAlarmTickResult {
  paused: number;
  alarmsSent: number;
}

const ALARM_STATES = new Set<SessionHealthCheck["state"]>(["AUTH_REQUIRED", "CHALLENGE"]);

/**
 * Watches persisted session health each daemon cycle. The moment an identity reports
 * AUTH_REQUIRED or CHALLENGE, the account's schedule is paused FIRST (durable, respected by the
 * due worker) and then exactly one German alarm per health check goes out with the remote-screen
 * link for the manual re-login. Recovery is deliberately human: the alarm ends with
 * "/fortsetzen <kanal>" -- nothing here ever unpauses automatically.
 */
export class SessionHealthAlarmService {
  private readonly clock: () => string;

  constructor(private readonly deps: SessionHealthAlarmDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async tick(now = this.clock()): Promise<SessionHealthAlarmTickResult> {
    const result: SessionHealthAlarmTickResult = { paused: 0, alarmsSent: 0 };
    const channelByAccount = new Map(this.deps.channels.map((channel) => [channel.accountId, channel]));
    for (const stored of this.deps.control.listBrowserIdentities()) {
      const identity = stored.identity;
      const health = this.deps.control.latestSessionHealth(identity.identityId);
      if (!health || !ALARM_STATES.has(health.state)) continue;
      const channel = channelByAccount.get(identity.accountId);
      const channelKey = channel?.key ?? identity.accountId;
      if (!this.deps.pauses.getSchedulePause(identity.accountId)) {
        this.deps.pauses.setSchedulePause({
          scopeKey: identity.accountId,
          channelKey,
          reason: `session_${health.state.toLocaleLowerCase("en-US")}`,
          pausedAt: now,
          pausedBy: "session-health-alarm"
        });
        result.paused += 1;
      }
      const eventKey = `session-alarm:${identity.identityId}:${health.checkId}`;
      if (this.deps.chatState.wasOperatorEventSent(eventKey)) continue;
      await this.deps.messenger.sendMessage(this.alarmText(channel?.name ?? channelKey, channelKey, channel?.platform ?? identity.platform, health));
      this.deps.chatState.markOperatorEventSent(eventKey, now);
      result.alarmsSent += 1;
    }
    return result;
  }

  private alarmText(channelName: string, channelKey: string, platform: string, health: SessionHealthCheck): string {
    const challenge = health.state === "CHALLENGE";
    return operatorMessageText(renderOperatorMessage("RELOGIN", {
      headline: challenge ? "Sicherheits-Challenge" : "Re-Login nötig",
      channelName,
      platformLabel: germanPlatformLabel(platform),
      channelKey,
      reason: challenge ? "Die Plattform verlangt eine Sicherheitsabfrage." : "Der Kanal ist abgemeldet.",
      ...(this.deps.remoteScreenUrl?.trim() ? { remoteScreenUrl: this.deps.remoteScreenUrl.trim() } : {})
    }));
  }
}
