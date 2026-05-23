// Google Calendar API v3 wrapper
// Uses fetch (no googleapis package) + OAuth2 refresh token flow

export type CalendarEvent = {
  id: string;
  title: string;
  startISO: string;
  endISO: string;
  description?: string;
};

export type TimeSlot = {
  startISO: string;
  endISO: string;
};

const CALENDAR_ID = "primary";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BASE_URL = "https://www.googleapis.com/calendar/v3";

// Refresh access token on every call — never cache it
export async function getAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in response");
  return data.access_token;
}

export async function getEvents(
  startISO: string,
  endISO: string
): Promise<CalendarEvent[]> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
  });
  const res = await fetch(
    `${BASE_URL}/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`getEvents failed: ${res.status}`);
  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      description?: string;
    }>;
  };
  if (!data.items) return [];
  return data.items.map((e) => ({
    id: e.id,
    title: e.summary || "(ไม่มีชื่อ)",
    startISO: e.start.dateTime || e.start.date || "",
    endISO: e.end.dateTime || e.end.date || "",
    description: e.description,
  }));
}

export async function createEvent(
  title: string,
  startISO: string,
  endISO: string,
  description?: string
): Promise<string> {
  const token = await getAccessToken();
  const res = await fetch(
    `${BASE_URL}/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: title,
        start: { dateTime: startISO, timeZone: "Asia/Bangkok" },
        end: { dateTime: endISO, timeZone: "Asia/Bangkok" },
        ...(description ? { description } : {}),
      }),
    }
  );
  if (!res.ok) throw new Error(`createEvent failed: ${res.status}`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function updateEvent(
  eventId: string,
  changes: Partial<CalendarEvent>
): Promise<void> {
  const token = await getAccessToken();
  const body: Record<string, unknown> = {};
  if (changes.title !== undefined) body.summary = changes.title;
  if (changes.startISO !== undefined)
    body.start = { dateTime: changes.startISO, timeZone: "Asia/Bangkok" };
  if (changes.endISO !== undefined)
    body.end = { dateTime: changes.endISO, timeZone: "Asia/Bangkok" };
  if (changes.description !== undefined) body.description = changes.description;

  const res = await fetch(
    `${BASE_URL}/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`updateEvent failed: ${res.status}`);
}

export async function deleteEvent(eventId: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(
    `${BASE_URL}/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  // 404 = already deleted, treat as success
  if (!res.ok && res.status !== 404)
    throw new Error(`deleteEvent failed: ${res.status}`);
}

export async function findFreeSlots(
  startISO: string,
  endISO: string,
  durationMin: number
): Promise<TimeSlot[]> {
  const events = await getEvents(startISO, endISO);
  const durationMs = durationMin * 60 * 1000;
  const rangeEnd = new Date(endISO);
  const slots: TimeSlot[] = [];
  let cursor = new Date(startISO);

  const busyTimes = events
    .map((e) => ({ start: new Date(e.startISO), end: new Date(e.endISO) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  for (const busy of busyTimes) {
    if (cursor.getTime() + durationMs <= busy.start.getTime()) {
      slots.push({
        startISO: cursor.toISOString(),
        endISO: new Date(cursor.getTime() + durationMs).toISOString(),
      });
      if (slots.length >= 3) return slots;
    }
    if (busy.end > cursor) cursor = busy.end;
  }

  // Check remaining time after last event
  if (
    slots.length < 3 &&
    cursor.getTime() + durationMs <= rangeEnd.getTime()
  ) {
    slots.push({
      startISO: cursor.toISOString(),
      endISO: new Date(cursor.getTime() + durationMs).toISOString(),
    });
  }

  return slots;
}
