import { describe, expect, it } from "vitest";
import { packToday } from "@/lib/agent";
import { datesIn, localToday, pastDates, scheduleFields, weekOf } from "@/lib/dates";

describe("today, where the restaurant is", () => {
  it("uses the restaurant's time zone, not the server's date", () => {
    // The Gjelina replay was recorded at 09:43 UTC on 21 Oct: 02:43 on Wednesday 21 Oct in Los Angeles.
    expect(localToday({ timezone: "America/Los_Angeles", now: new Date("2026-10-21T09:43:00Z") })).toBe("2026-10-21");
    // At 05:00 UTC it is still Tuesday evening there.
    expect(localToday({ timezone: "America/Los_Angeles", now: new Date("2026-10-21T05:00:00Z") })).toBe("2026-10-20");
    expect(localToday({ timezone: "Europe/Madrid", now: new Date("2026-10-20T22:30:00Z") })).toBe("2026-10-21");
  });

  it("falls back to the longitude when the time zone is unknown", () => {
    expect(localToday({ lon: -118.46, now: new Date("2026-10-21T05:00:00Z") })).toBe("2026-10-20");
    expect(localToday({ timezone: "Not/AZone", lon: -3.7, now: new Date("2026-10-21T05:00:00Z") })).toBe("2026-10-21");
  });

  it("gives the writer the week as a calendar", () => {
    expect(weekOf("2026-10-21").map((d) => d.label)).toEqual(["Wed 21 Oct", "Thu 22 Oct", "Fri 23 Oct", "Sat 24 Oct", "Sun 25 Oct", "Mon 26 Oct", "Tue 27 Oct"]);
  });

  it("reads a pack's date: stored since v7, else the first forecast day of its context", () => {
    expect(packToday({ today: "2026-10-21", context: "", place: { name: "x", city: "y", lat: 0, lon: 0, match: "city" } })).toBe("2026-10-21");
    // A pack gathered at 01:00 UTC on 21 Oct for Los Angeles stated the UTC date; its forecast starts on the 20th.
    const context = "Restaurant: Gjelina — Los Angeles\nToday: 2026-10-21\nFORECAST:\nTue 20 Oct: clear, max 24°C / min 15°C, 0 mm\nWed 21 Oct: drizzle";
    expect(packToday({ context, place: { name: "Gjelina", city: "Los Angeles", lat: 33.99, lon: -118.46, match: "exact" } })).toBe("2026-10-20");
    expect(packToday({ context: "Today: Wed 21 Oct 2026 (2026-10-21), the restaurant's local date", place: { name: "x", city: "y", lat: 0, lon: 0, match: "city" } })).toBe("2026-10-21");
  });
});

describe("dates in the plan", () => {
  const today = "2026-10-21";

  it("finds day-and-month dates, ranges and ISO dates; a weekday alone is not a date", () => {
    expect(datesIn("Tue 20 Oct, 4:30 PM (afternoon before first rain day)", today)).toEqual(["2026-10-20"]);
    expect(datesIn("Wed 21–Thu 22 Oct", today)).toEqual(["2026-10-21", "2026-10-22"]);
    expect(datesIn("Sat 24 – Sun 25 October, brunch", today)).toEqual(["2026-10-24", "2026-10-25"]);
    expect(datesIn("Thursday, Oct. 22nd at lunch; review on 2026-10-27", today)).toEqual(["2026-10-22", "2026-10-27"]);
    expect(datesIn("mar 20 oct: pedido al proveedor; jueves 22 de octubre, cena", today)).toEqual(["2026-10-20", "2026-10-22"]);
    expect(datesIn("Rain on Thursday: 39.2 mm, 19/15°C, 49% chance; post at 11 AM", today)).toEqual([]);
  });

  it("picks the year nearest to today across New Year", () => {
    expect(datesIn("Fri 1 Jan", "2026-12-29")).toEqual(["2027-01-01"]);
    expect(datesIn("Mon 28 Dec", "2027-01-02")).toEqual(["2026-12-28"]);
  });

  it("flags the recorded Gjelina plan: an order and a post dated the day before the run", () => {
    // As recorded on 21 Oct 2026 (local date in Los Angeles), before the date guard.
    const plan = {
      moments: [{ when: "Wed 21 Oct, lunch" }, { when: "Thu 22 Oct, lunch" }],
      menu_moves: [{ when: "Wed 21–Thu 22 Oct" }, { when: "Sat 24–Sun 25 Oct" }],
      experience: { event_why: "Runs Thu 22 Oct at lunch: free hot tea with any bowl." },
      marketing: { post_when: "Tue 20 Oct, 4:30 PM (afternoon before first rain day)" },
      week_plan: [
        { day: "Tue 20 Oct", action: "Place produce, dairy, bakery, dry goods orders for all three specials; confirm delivery Wed AM." },
        { day: "Wed 21 Oct", action: "Launch Braised Chickpea & Lacinato Kale Bowl ($25) at lunch; post Instagram story 11 AM." },
        { day: "Tue 27 Oct", action: "Run salad again; tally covers, waste, and guest feedback for all three specials." },
      ],
    };
    const { checked, past } = pastDates(scheduleFields(plan), today);
    expect(checked).toBe(11);
    expect(past.map((p) => p.where)).toEqual(["week_plan.0.day", "marketing.post_when"]);
    expect(past[1].date).toBe("2026-10-20");
    // Re-dated to today, it passes.
    const fields = scheduleFields(plan);
    fields.find((f) => f.where === "week_plan.0.day")!.set("Wed 21 Oct");
    fields.find((f) => f.where === "marketing.post_when")!.set("Wed 21 Oct, 4:30 PM (afternoon before the first rain day)");
    expect(pastDates(fields, today).past).toEqual([]);
  });
});
