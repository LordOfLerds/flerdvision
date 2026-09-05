import type { OperatorChannelRef, OperatorPlanView } from "./operator-plan-view.js";
import type { ScheduleTargetView } from "./schedule-commands.js";

export interface OperatorCustomerRef {
  customerKey: string;
  customerName: string;
}

/**
 * One business/customer map derived from the canonical schedule/spec read model. A channel may
 * have several formats, but every format must project the same customer. Conflicting projections
 * fail closed rather than showing a misleading customer in Telegram.
 */
export function customerByChannel(views: readonly ScheduleTargetView[]): ReadonlyMap<string, OperatorCustomerRef> {
  const result = new Map<string, OperatorCustomerRef>();
  for (const view of views) {
    const current = result.get(view.channelKey);
    if (current && (current.customerKey !== view.customerKey || current.customerName !== view.customerName)) {
      throw new Error(`Kanal ${view.channelKey} hat widersprüchliche Kundenzuordnungen.`);
    }
    result.set(view.channelKey, { customerKey: view.customerKey, customerName: view.customerName });
  }
  return result;
}

export function customerChannelLabel(channelKey: string, channelName: string, views: readonly ScheduleTargetView[]): string {
  const customer = customerByChannel(views).get(channelKey);
  return customer ? `${customer.customerName} · ${channelName}` : channelName;
}

export function customerAwareChannels(
  channels: readonly OperatorChannelRef[],
  scheduleViews: readonly ScheduleTargetView[]
): readonly OperatorChannelRef[] {
  return channels.map((channel) => ({
    ...channel,
    name: customerChannelLabel(channel.key, channel.name, scheduleViews)
  }));
}

/**
 * Business overlay only: it never changes intent identity, times, state, evidence or ordering.
 * The ordinary plan renderer remains authoritative for all status/safety wording.
 */
export function customerAwarePlanView(view: OperatorPlanView, scheduleViews: readonly ScheduleTargetView[]): OperatorPlanView {
  const customers = customerByChannel(scheduleViews);
  const label = (channelKey: string, channelName: string): string => {
    const customer = customers.get(channelKey);
    return customer ? `${customer.customerName} · ${channelName}` : channelName;
  };
  const entries = view.entries.map((entry) => ({ ...entry, channelName: label(entry.channelKey, entry.channelName) }));
  const channelGaps = view.channelGaps.map((gap) => ({ ...gap, channelName: label(gap.channelKey, gap.channelName) }));
  const nextSlotEntries = view.nextSlot
    ? entries.filter((entry) => entry.timeLocal === view.nextSlot!.timeLocal)
    : [];
  return {
    ...view,
    entries,
    channelGaps,
    ...(view.nextSlot
      ? {
          nextSlot: {
            ...view.nextSlot,
            channelNames: nextSlotEntries.length > 0
              ? [...new Set(nextSlotEntries.map((entry) => entry.channelName))]
              : view.nextSlot.channelNames
          }
        }
      : {})
  };
}
