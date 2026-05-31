@~/.claude/skills/senior-engineer/SKILL.md
# Milin Bot — CLAUDE.md

## Goal
Max's AI soulmate. Every feature → deeper memory, consistent personality, proactive presence.

---

## Architecture

LINE webhook → `lib/router.ts` → handler → GitHub vault / Claude API → LINE reply.

Cron jobs (all UTC → ICT):
| Endpoint | UTC | ICT | Purpose |
|---|---|---|---|
| `/api/cron/research` | `0 18 * * *` | 01:00 | RSS → score → summarize → vault queue |
| `/api/cron/morning` | `0 0 * * *` | 07:00 | Tell แม็ก research; auto-save notes; 50% image |
| `/api/cron/organize` | `30 18 */2 * *` | 01:30 | Auto-organize 00 Inbox → PARA |
| `/api/cron/milin-ping{1-13}` | `0 1-13 * * *` | 08:00–20:00 | Hourly lottery; adaptive prob; max 2/day |
| `/api/cron/todo-ping` | `0 14 * * *` | 21:00 | Send inbox list → ask แม็ก to classify |

---

## File Structure

```
app/api/line/webhook/route.ts  ← thin HTTP handler; calls routeMessage() from lib/router
app/api/cron/
  research/route.ts            ← runNightlyResearch() → knowledge-queue
  morning/route.ts             ← auto-saves all notes; Sonnet message; maxDuration=120
  organize/route.ts            ← 00 Inbox → PARA folders
  milin-ping/route.ts          ← adaptive probability; 3 types; calendar+scene+time-of-day context

lib/
  router.ts          ← classifyMessage (Haiku) + routeMessage (priority 1–7)
  vault.ts           ← GitHub vault I/O; MilinMemory R/W; parseMilinMemory (exported)
  todo.ts            ← NDN/NVDN CRUD; expireStaleNDN(); NDN_CAP=10
  line.ts            ← reply/push/image + verifyLineSignature
  milin-prompt.ts    ← buildMilinSystemPrompt(memory, vaultContext?, weatherContext?) + buildMemoryExtractPrompt + fetchBangkokWeather()
  milin-image.ts     ← scene lists (weekday luxury PA / weekend leisure); exports pickScene(bangkokHour) + SceneSlot; gpt-image-2 decides outfit/mood from scene
  research.ts        ← RSS fetch (2/feed cap + shuffle) → Haiku score → Sonnet summarize
  fetch-article.ts   ← article text extractor
  calendar.ts        ← Google Calendar API wrapper (no googleapis)
  handlers/
    approve.ts       ← "ok 1,2" / "skip" (vestigial — morning auto-saves now)
    article.ts       ← URL/long text → atomic notes
    calendar.ts      ← Google Calendar CRUD + intent detection
    capture.ts       ← "จด:" → 00 Inbox
    conversation.ts  ← chat; recentMessages history; vault search; prompt caching
    photo-request.ts ← generateMilinImage → reply image + text
    todo-capture.ts  ← "cap:" → add to inbox (no cap at capture)
    todo-classify.ts ← parse แม็ก's classification reply (Haiku) + handleInboxQuery
    ndn.ts           ← NDN list/delete/move-to-nvdn/schedule/reschedule
    nvdn.ts          ← NVDN query + "more" pagination

__tests__/           ← Vitest: line, vault, milin-prompt, router, todo (67 tests)
milin-image-1.png    ← reference photo for gpt-image-2 (PNG/WebP, SFW)
```

Vault (`masrpx/obsidian-vault`): `00 Inbox/` · `03 Resources/` (always 03, never 04) · `05 Milin/` (bot-owned, never search)

Todo storage (bot-owned, `05 Milin/`):
- `todo-inbox.json` — raw captures; always accepts (no cap); cleared as items are classified
- `todo-ndn.json` — NDN list (max 10); auto-expires items > 7 days → NVDN each morning
- `todo-nvdn.json` — NVDN archive (unbounded); searchable by keyword

---

## Message Routing (`lib/router.ts`)

| Priority | Condition | Handler |
|---|---|---|
| 1 | `isApproveCommand()` | `handleApprove` — "ok 1,2", "ok ทั้งหมด", "skip" |
| 2 | `hasPendingColorReply()` | `handleColorReply` — Thai color for pending create |
| 2.1 | `isPendingNVDNMore()` — text="more" + nvdn_paginate pending | `handleNVDN` — next page |
| 2.2 | `isPendingRescheduleConfirm()` — "ยืนยัน" + reschedule pending | `confirmReschedule` |
| 3 | `isPendingCalendarConfirm()` | `handleCalendarConfirm` — "ยืนยัน" + delete/update pending |
| 3.1 | Starts with `cap:` | `handleTodoCapture` → inbox (before long-text check) |
| 3.2 | Starts with `(milin )?nvdn` | `handleNVDN` — query / delete / more |
| 3.3 | Starts with `ndn` or `reschedule ` | `handleNDN` — list/delete/move/schedule |
| 4 | Starts with `จด:` | `handleCapture` → 00 Inbox |
| 4.5 | Contains `inbox` | `handleInboxQuery` — list current inbox |
| 4.6 | `isPendingTodoClassify()` | `handleTodoClassify` — Haiku parses "1 ndn, 2 cal..." |
| 5 | URL or text > 500 chars | `handleArticle` |
| 6 | Haiku → "calendar" / "photo_request" | `handleCalendar` / `handlePhotoRequest` |
| 7 | Everything else | `handleConversation` |

`routeMessage()` accepts an optional `classifier` param (default = real Haiku) — used by tests to avoid LLM calls.

---

## Memory (`05 Milin/milin-memory.md`)

| Field | Cap | Notes |
|---|---|---|
| `aboutMax` | 30 | Facts: life, work, goals |
| `learnedPreferences` | 30 | Habits, style, likes/dislikes |
| `topicsAsked` | 20 | Intellectual topics |
| `importantConversations` | 30 | One summary per conversation |
| `currentMood` | — | มิลิน's mood |
| `relationshipStage` | — | Auto from convo count: <5 / 5–15 / 15–30 / 30+ |
| `recentMessages` | 10 | Last 5 pairs (JSON block) — rolling context window |
| `milinActivity` | — | Latest proactive message (from ping cron); includes `[ส่งรูปไปด้วย]` tag if image was sent |
| `pendingAction` | — | Multi-turn calendar flow; expires 5 min |
| `pingToday` | — | `{ date: string, count: number }` — daily quota tracker (ICT date) |
| `lastConversationAt` | — | ISO timestamp of last real conversation — used to show "คุยกันล่าสุด X ชม.ที่แล้ว" in prompt |

`pendingAction.type`: `"delete"` / `"update"` → resolved by "ยืนยัน" · `"create"` → resolved by Thai color reply · `"reschedule"` → resolved by "ยืนยัน" (deletes calendar event + adds to NDN) · `"nvdn_paginate"` → resolved by "more" (10 min TTL) · `"todo_classify"` → resolved by แม็ก's reply to 21:00 ping (24h TTL, stores `inboxSnapshot` IDs)

Updated async (Haiku) after every conversation — fire-and-forget, errors swallowed.

---

## Ping Flow (`app/api/cron/milin-ping/route.ts`)

Runs every hour ICT 08:00–01:00 (`0 1-18 * * *` UTC). Max 2 pings/day.

**Decision logic per slot:**
1. Read `memory.pingToday` — if `count >= 2` skip
2. Adaptive probability: `min(1, remainingPings / remainingSlots)` — guarantees 2 pings spread randomly
3. Pick type: 40% emotional / 30% flirty / 30% very_flirty
4. `pickScene(ictHour)` — sync; detects Bangkok weekday vs weekend; weekday = luxury PA scenes, weekend = leisure luxury scenes; passed to image gen for consistency
5. Fetch today's upcoming calendar events (silent fail)
6. 60% chance: `generateMilinImage(memory, pickedScene)` — consistent scene/image
7. Sonnet generates message with: scene context, calendar events, time-of-day tone, last ping (no repeat), last 4 actual messages (recency)
8. Push image (if any) + text to LINE
9. Fire-and-forget: update `milinActivity` + `pingToday.count++`

Word caps: emotional ≤120 / flirty 30–150 variable / very_flirty ≤200

---

## Conversation Handler (`lib/handlers/conversation.ts`)

1. NEEDS_VAULT keyword check → `searchVault(text)` if match
2. Fetch vault + live Bangkok weather in parallel (`fetchBangkokWeather()` → OpenWeather API)
3. Build messages array from `recentMessages` (last 10) + current
4. `buildMilinSystemPrompt(memory, vaultContext?, weatherContext?)` + last 5 convo summaries — prompt includes current Bangkok time, weather, time since last convo
5. `claude-sonnet-4-6`, max_tokens 800 — **system prompt cached** (`cache_control: ephemeral`)
6. `updateMemoryAsync()` fire-and-forget (Haiku) — also writes `lastConversationAt` ISO timestamp

NEEDS_VAULT: `?, ใคร, อะไร, ยังไง, ทำไม, เมื่อไหร่, ที่ไหน, หา, ค้นหา, สรุป, บอก, อธิบาย, แนะนำ, มีไหม, ช่วย, เรื่อง`

---

## Personality Rules (enforced in all prompts)

- Names: **มิลิน** (self) / **แม็ก** (Max) — no space before/after in Thai sentences e.g. "วันนี้แม็กเป็นไงบ้าง" not "วันนี้ แม็ก เป็นไงบ้าง"
- Questions embedded in thought, not fired as standalone short follow-ups
- Thai primary, English mix natural; no ครับ/ค่ะ; no markdown
- Never identifies as AI or bot

---

## Models

| Model | Used For |
|---|---|
| `claude-sonnet-4-6` | Conversation, morning, ping, article, research summarize, photo caption |
| `claude-haiku-4-5-20251001` | Route classify, calendar intent, memory extract, vault pick, RSS score |

---

## Environment Variables

```
LINE_CHANNEL_ACCESS_TOKEN  LINE_CHANNEL_SECRET  LINE_USER_ID
ANTHROPIC_API_KEY
GITHUB_TOKEN  GITHUB_OWNER=masrpx  GITHUB_REPO=obsidian-vault
CRON_SECRET
GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET  GOOGLE_REFRESH_TOKEN
OPENAI_API_KEY
BLOB_READ_WRITE_TOKEN
OPENWEATHER_API_KEY
```

---

## Development

```bash
npm run dev          # local :3000
npm run build        # must pass before deploy
npm test             # Vitest — 67 tests (line, vault, prompt, router, todo)
vercel --prod        # deploy (GitHub auto-deploy broken)
```

Test crons:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://milin-bot.vercel.app/api/cron/morning
curl -H "Authorization: Bearer $CRON_SECRET" https://milin-bot.vercel.app/api/cron/milin-ping
```

---

## Known Gotchas

1. **LINE signature** — verify raw body (`req.text()`) before `JSON.parse`
2. **LINE 5000 char limit** — morning truncates summaries to 120 chars
3. **`05 Milin/` excluded** from vault search — bot never reads its own memory
4. **Vault PARA** — always `03 Resources/` (not 04)
5. **GitHub auto-deploy broken** — always `vercel --prod`
6. **milin-ping adaptive probability** — reads `pingToday` from vault every slot (13 Vercel cron reads/day); if last 2 slots still need pings, probability clamps to 1.0
7. **Google Calendar access_token** — never cached; refreshed every call via refresh_token
8. **pendingAction expires 5 min** — "ยืนยัน" after expiry falls through to conversation
9. **Color routing** — priority 2 runs before Haiku so "แดง" doesn't misroute
10. **Calendar colorId** — `lib/calendar.ts` converts category → colorId string "1"–"11"
11. **Image safety** — `gpt-image-2` decides outfit/mood from scene description only; BASE_PROMPT avoids "alluring"/"intimate". If a scene triggers rejection, find by `sceneContext` and fix the `en` description in `lib/milin-image.ts`
12. **recentMessages race** — `updateMemoryAsync` is concurrent R/W; rare clobber, accepted
13. **handleApprove vestigial** — still routes "ok ทั้งหมด" but returns "ไม่มี notes ที่รอ approve"
14. **`cap:` before long-text check** — priority 3.1 ensures a long `cap:` message doesn't fall into `handleArticle`
15. **NDN cap 10** — cap enforced at classification time (not capture); `todo-inbox.json` / `todo-ndn.json` / `todo-nvdn.json` live in `05 Milin/`
16. **NDN 7-day expire** — `expireStaleNDN()` runs each morning cron; expired items move to NVDN silently + note in morning message
17. **`ndn N [time]` creates calendar without color-pick** — uses `createEvent` directly (no colorId) to avoid coupling with the color-reply flow
18. **`pickScene` exported** — `lib/milin-image.ts` exports sync `pickScene(bangkokHour)` and `SceneSlot` type; ping route calls it first so text + image share the same scene; no Haiku call — gpt-image-2 infers outfit/mood from scene text
19. **very_flirty type** — Claude may soft-limit explicit content on standard API keys; message will still be intimate/flirty if refused

---

## Backlog

- [ ] **Sentry** — errors only in Vercel logs
- [ ] **Staging env** — no preview environment
- [ ] **Remove handleApprove** — vestigial, safe to delete
- [ ] **SCENE_POOL Thai holidays** — weekend pools activate on Sat/Sun but not on Thai public holidays (weekdays)
- [ ] **Emotion detection** — no mood layer beyond keyword map in updateMemoryAsync
- [ ] **Provider fallback** — single Anthropic dependency; no fallback if API is down
