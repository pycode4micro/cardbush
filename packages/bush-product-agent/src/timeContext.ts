export interface TurnTimeContextInput {
  createdAt: string;
  timeZone?: unknown;
  timeZoneSource?: "user_device" | "scheduled_task";
}

function canonicalTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Derive once from the persisted input timestamp, never from a model-round clock. */
export function createTurnTimeContext(input: TurnTimeContextInput): string {
  const instant = new Date(input.createdAt);
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid turn timestamp for time context.");
  const suppliedZone = canonicalTimeZone(input.timeZone);
  const timeZone = suppliedZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const source = suppliedZone ? input.timeZoneSource ?? "user_device" : "runtime_host";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  const offset = part("timeZoneName").replace("GMT", "UTC");
  return [
    "<time_context>",
    `Current date: ${part("year")}-${part("month")}-${part("day")} (${part("weekday")})`,
    `Current time: ${part("hour")}:${part("minute")}:${part("second")} ${offset}`,
    `Time zone: ${timeZone}`,
    `Time zone source: ${source}`,
    `Snapshot at message submission (UTC): ${instant.toISOString()}`,
    "</time_context>",
  ].join("\n");
}
