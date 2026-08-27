import type { DistributionRoute } from "./distribution.js";
import type { SchedulingPolicy } from "./scheduling.js";

export interface OperatingCalendarWeekdayRule {
  /** ISO weekday: Monday=1 ... Sunday=7. */
  isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  active: boolean;
  /** Optional rhythm override for this weekday. Otherwise the route's default schedule policy applies. */
  schedulePolicyId?: string;
}

export interface OperatingCalendarDateOverride {
  businessDate: string;
  active: boolean;
  /** Optional one-day rhythm override. */
  schedulePolicyId?: string;
  note?: string;
}

export interface OperatingCalendar {
  calendarId: string;
  displayName: string;
  enabled: boolean;
  weekdayRules: readonly OperatingCalendarWeekdayRule[];
  dateOverrides: readonly OperatingCalendarDateOverride[];
}

export interface EffectiveRouteCalendarDecision {
  active: boolean;
  schedulePolicyId: string;
  source: "ROUTE_DEFAULT" | "WEEKDAY" | "DATE_OVERRIDE";
  note?: string;
}

function isoWeekday(businessDate: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error(`Invalid business date: ${businessDate}`);
  const [year, month, day] = businessDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.toISOString().slice(0, 10) !== businessDate) throw new Error(`Invalid business date: ${businessDate}`);
  const weekday = date.getUTCDay();
  return (weekday === 0 ? 7 : weekday) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export function assertOperatingCalendar(calendar: OperatingCalendar): void {
  if (!calendar.calendarId.trim()) throw new Error("Operating calendar id cannot be empty");
  if (!calendar.displayName.trim()) throw new Error(`Operating calendar ${calendar.calendarId} needs a display name`);
  const weekdayIds = calendar.weekdayRules.map((rule) => rule.isoWeekday);
  if (new Set(weekdayIds).size !== weekdayIds.length) throw new Error(`Operating calendar ${calendar.calendarId} has duplicate weekday rules`);
  for (const override of calendar.dateOverrides) isoWeekday(override.businessDate);
  const dates = calendar.dateOverrides.map((item) => item.businessDate);
  if (new Set(dates).size !== dates.length) throw new Error(`Operating calendar ${calendar.calendarId} has duplicate date overrides`);
}

export function assertOperatingCalendarCatalog(
  calendars: readonly OperatingCalendar[],
  schedulePolicies: Readonly<Record<string, SchedulingPolicy>>
): void {
  const ids = calendars.map((calendar) => calendar.calendarId);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate operating calendar id");
  for (const calendar of calendars) {
    assertOperatingCalendar(calendar);
    for (const rule of calendar.weekdayRules) {
      if (rule.schedulePolicyId && !schedulePolicies[rule.schedulePolicyId]) {
        throw new Error(`Operating calendar ${calendar.calendarId} weekday ${rule.isoWeekday} references missing schedule policy ${rule.schedulePolicyId}`);
      }
    }
    for (const override of calendar.dateOverrides) {
      if (override.schedulePolicyId && !schedulePolicies[override.schedulePolicyId]) {
        throw new Error(`Operating calendar ${calendar.calendarId} date ${override.businessDate} references missing schedule policy ${override.schedulePolicyId}`);
      }
    }
  }
}

export function assertRouteCalendarReference(route: DistributionRoute, calendars: readonly OperatingCalendar[]): void {
  if (!route.operatingCalendarId) return;
  if (!calendars.some((calendar) => calendar.calendarId === route.operatingCalendarId)) {
    throw new Error(`Route ${route.routeId} references missing operating calendar ${route.operatingCalendarId}`);
  }
}

export function effectiveRouteCalendar(
  route: DistributionRoute,
  businessDate: string,
  calendars: Readonly<Record<string, OperatingCalendar>> = {}
): EffectiveRouteCalendarDecision {
  if (!route.operatingCalendarId) {
    return { active: true, schedulePolicyId: route.schedulePolicyId, source: "ROUTE_DEFAULT" };
  }
  const calendar = calendars[route.operatingCalendarId];
  if (!calendar || !calendar.enabled) {
    return { active: false, schedulePolicyId: route.schedulePolicyId, source: "ROUTE_DEFAULT", note: "calendar_missing_or_disabled" };
  }
  assertOperatingCalendar(calendar);
  const dateOverride = calendar.dateOverrides.find((item) => item.businessDate === businessDate);
  if (dateOverride) {
    return {
      active: dateOverride.active,
      schedulePolicyId: dateOverride.schedulePolicyId ?? route.schedulePolicyId,
      source: "DATE_OVERRIDE",
      ...(dateOverride.note ? { note: dateOverride.note } : {})
    };
  }
  const weekdayRule = calendar.weekdayRules.find((item) => item.isoWeekday === isoWeekday(businessDate));
  if (!weekdayRule) return { active: true, schedulePolicyId: route.schedulePolicyId, source: "ROUTE_DEFAULT" };
  return {
    active: weekdayRule.active,
    schedulePolicyId: weekdayRule.schedulePolicyId ?? route.schedulePolicyId,
    source: "WEEKDAY"
  };
}
