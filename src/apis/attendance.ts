import { legistarFetch } from "./legistar.js";

interface RollCallEntry {
  personId: number;
  personName: string;
  value: string;
}

interface MeetingAttendance {
  eventId: number;
  date: string;
  body: string;
  records: RollCallEntry[];
}

export async function getCouncilAttendance(
  opts?: { limit?: number; personName?: string },
): Promise<{ meetings: MeetingAttendance[]; errors: string[] }> {
  const meetings: MeetingAttendance[] = [];
  const errors: string[] = [];
  const limit = opts?.limit ?? 10;

  try {
    const events = (await legistarFetch("/events", {
      filter: `EventBodyName eq 'City Council' and EventDate lt datetime'${new Date().toISOString().slice(0, 10)}'`,
      orderby: "EventDate desc",
      top: String(limit),
    })) as any[];

    for (const event of events) {
      try {
        const items = (await legistarFetch(`/events/${event.EventId}/eventitems`, {
          filter: "EventItemRollCallFlag eq 1",
        })) as any[];

        if (items.length === 0) continue;

        const rollcalls = (await legistarFetch(
          `/eventitems/${items[0].EventItemId}/rollcalls`,
        )) as any[];

        const records: RollCallEntry[] = rollcalls.map((rc: any) => ({
          personId: rc.RollCallPersonId,
          personName: rc.RollCallPersonName ?? "",
          value: rc.RollCallValueName ?? "Unknown",
        }));

        const filtered = opts?.personName
          ? records.filter(r =>
              r.personName.toLowerCase().includes(opts.personName!.toLowerCase()),
            )
          : records;

        meetings.push({
          eventId: event.EventId,
          date: event.EventDate?.slice(0, 10) ?? "",
          body: event.EventBodyName ?? "City Council",
          records: filtered,
        });
      } catch (e) {
        errors.push(`Event ${event.EventId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`Attendance fetch: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { meetings, errors };
}
