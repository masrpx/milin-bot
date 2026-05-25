// Evening ping (19:00 ICT / 12:00 UTC) — same logic as the midday ping.
// Keeping it as a separate cron path so both can be scheduled independently.
export { GET, maxDuration } from "@/app/api/cron/milin-ping/route";
