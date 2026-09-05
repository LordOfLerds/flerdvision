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
  /** Authenticated/private noVNC/remote-screen URL (env FLERDVISION_REMOTE_SCREEN_URL). */
  remoteScreenUrl?: string;
  clock?: () => string;
}

export interface SessionHealthAlarmTickResult {
  paused: number;
  resumed: number;
  alarmsSent: number;
}

const ALARM_STATES = new Set<SessionHealthCheck["state"]>(["AUTH_REQUIRED", "CHALLENGE", "IDENTITY_MISMATCH"]);

function isAlarmOwnedPause(pause: ReturnType<SchedulePauseStorePort["getSchedulePause"]>): boolean {
  return Boolean(pause && pause.pausedBy === "session-health-alarm" && pause.reason.startsWith("session_"));
}

/**
 * Watches persisted session health each daemon cycle. An auth/challenge/identity problem pauses
 * the account BEFORE the alarm is sent. Once a later real health check proves HEALTHY again, only
 * the pause created by this service is removed automatically. A human/operator pause is never
 * overwritten or auto-cleared.
 */
export class SessionHealthAlarmService {
  private readonly clock: () => string;

  constructor(private readonly deps: SessionHealthAlarmDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async tick(now = this.clock()): Promise<SessionHealthAlarmTickResult> {
    const result: SessionHealthAlarmTickResult = { paused: 0, resumed: 0, alarmsSent: 0 };
    const channelByAccount = new Map(this.deps.channels.map((channel) => [channel.accountId, channel]));
    for (const stored of this.deps.control.listBrowserIdentities()) {
      const identity = stored.identity;
      const health = this.deps.control.latestSessionHealth(identity.identityId);
      if (!health) continue;
      const currentPause = this.deps.pauses.getSchedulePause(identity.accountId);

      if (health.state === "HEALTHY") {
        if (isAlarmOwnedPause(currentPause) && this.deps.pauses.clearSchedulePause(identity.accountId)) result.resumed += 1;
        continue;
      }
      if (!ALARM_STATES.has(health.state)) continue;

      const channel = channelByAccount.get(identity.accountId);
      const channelKey = channel?.key ?? identity.accountId;
      if (!currentPause) {
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
    const mismatch = health.state === "IDENTITY_MISMATCH";
    return operatorMessageText(renderOperatorMessage("ATTENTION", {
      badge: "🛑",
      headline: mismatch ? "Falsches Konto" : challenge ? "Sicherheits-Challenge" : "Re-Login nötig",
      channelName,
      platformLabel: germanPlatformLabel(platform),
      channelKey,
      reason: mismatch
        ? "Im Browser ist das falsche Konto angemeldet. Der Kanal bleibt gesperrt, damit nichts im falschen Konto landet."
        : challenge
          ? "Die Plattform verlangt eine Sicherheitsabfrage."
          : "Der Kanal ist abgemeldet.",
      nextStep: "Login/Challenge im Browser abschließen. Sobald HEALTHY bewiesen ist, läuft der Kanal automatisch weiter.",
      ...(this.deps.remoteScreenUrl?.trim() ? { remoteScreenUrl: this.deps.remoteScreenUrl.trim() } : {})
    }));
  }
}
