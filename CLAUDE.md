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
| `/api/cron/morning` | `0 0 * * *` | 07:00 | Tell Max research; auto-save notes; 50% image |
| `/api/cron/organize` | `30 18 */2 * *` | 01:30 | Auto-organize 00 Inbox → PARA |
| `/api/cron/milin-ping` | `0 6 * * *` | 13:00 | Milin-initiated msg (60% + image) |
| `/api/cron/milin-ping-evening` | `0 12 * * *` | 19:00 | Same as ping |

---

## File Structure

```
app/api/line/webhook/route.ts  ← thin HTTP handler; calls routeMessage() from lib/router
app/api/cron/
  research/route.ts            ← runNightlyResearch() → knowledge-queue
  morning/route.ts             ← auto-saves all notes; Sonnet message; maxDuration=120
  organize/route.ts            ← 00 Inbox → PARA folders
  milin-ping/route.ts          ← push msg + image; saves milinActivity
  milin-ping-evening/route.ts  ← same as milin-ping

lib/
  router.ts          ← classifyMessage (Haiku) + routeMessage (priority 1–7)
  vault.ts           ← GitHub vault I/O; MilinMemory R/W; parseMilinMemory (exported)
  line.ts            ← reply/push/image + verifyLineSignature
  milin-prompt.ts    ← buildMilinSystemPrompt + buildMemoryExtractPrompt
  milin-image.ts     ← SCENE_POOL (14 scenes) → gpt-image-2 edit → imageUrl + sceneContext
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

__tests__/           ← Vitest: line, vault, milin-prompt, router (46 tests)
milin-image-1.png    ← reference photo for gpt-image-2 (PNG/WebP, SFW)
```

Vault (`masrpx/obsidian-vault`): `00 Inbox/` · `03 Resources/` (always 03, never 04) · `05 Milin/` (bot-owned, never search)

---

## Message Routing (`lib/router.ts`)

| Priority | Condition | Handler |
|---|---|---|
| 1 | `isApproveCommand()` | `handleApprove` — "ok 1,2", "ok ทั้งหมด", "skip" |
| 2 | `hasPendingColorReply()` | `handleColorReply` — Thai color for pending create |
| 3 | `isPendingCalendarConfirm()` | `handleCalendarConfirm` — "ยืนยัน" + valid pending |
| 4 | Starts with `จด:` | `handleCapture` → 00 Inbox |
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
| `currentMood` | — | Milin's mood |
| `relationshipStage` | — | Auto from convo count: <5 / 5–15 / 15–30 / 30+ |
| `recentMessages` | 10 | Last 5 pairs (JSON block) — rolling context window |
| `milinActivity` | — | Latest proactive message (from ping crons) |
| `pendingAction` | — | Multi-turn calendar flow; expires 5 min |

`pendingAction.type`: `"delete"` / `"update"` → resolved by "ยืนยัน" · `"create"` → resolved by Thai color reply

Updated async (Haiku) after every conversation — fire-and-forget, errors swallowed.

---

## Conversation Handler (`lib/handlers/conversation.ts`)

1. NEEDS_VAULT keyword check → `searchVault(text)` if match
2. Build messages array from `recentMessages` (last 10) + current
3. `buildMilinSystemPrompt(memory, vaultContext?)` + last 5 convo summaries
4. `claude-sonnet-4-6`, max_tokens 800 — **system prompt cached** (`cache_control: ephemeral`)
5. `updateMemoryAsync()` fire-and-forget (Haiku)

NEEDS_VAULT: `?, ใคร, อะไร, ยังไง, ทำไม, เมื่อไหร่, ที่ไหน, หา, ค้นหา, สรุป, บอก, อธิบาย, แนะนำ, มีไหม, ช่วย, เรื่อง`

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
```

---

## Development

```bash
npm run dev          # local :3000
npm run build        # must pass before deploy
npm test             # Vitest — 46 tests (line, vault, prompt, router)
vercel --prod        # deploy (GitHub auto-deploy broken)
```

Test crons:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://milin-bot.vercel.app/api/cron/morning
curl -H "Authorization: Bearer $CRON_SECRET" https://milin-bot.vercel.app/api/cron/research
```

---

## Known Gotchas

1. **LINE signature** — verify raw body (`req.text()`) before `JSON.parse`
2. **LINE 5000 char limit** — morning truncates summaries to 120 chars
3. **`05 Milin/` excluded** from vault search — bot never reads its own memory
4. **Vault PARA** — always `03 Resources/` (not 04)
5. **GitHub auto-deploy broken** — always `vercel --prod`
6. **milin-ping** — 40% intentional skip (`{"ok":true,"sent":false}`)
7. **Google Calendar access_token** — never cached; refreshed every call via refresh_token
8. **pendingAction expires 5 min** — "ยืนยัน" after expiry falls through to conversation
9. **Color routing** — priority 2 runs before Haiku so "แดง" doesn't misroute
10. **Calendar colorId** — `lib/calendar.ts` converts category → colorId string "1"–"11"
11. **Image safety** — `gpt-image-2` rejects sexual content; SCENE_POOL only, never free-form. If scene triggers: find by `sceneContext`, fix in `lib/milin-image.ts`
12. **recentMessages race** — `updateMemoryAsync` is concurrent R/W; rare clobber, accepted
13. **handleApprove vestigial** — still routes "ok ทั้งหมด" but returns "ไม่มี notes ที่รอ approve"

---

## Backlog

- [ ] **Sentry** — errors only in Vercel logs
- [ ] **Staging env** — no preview environment
- [ ] **Remove handleApprove** — vestigial, safe to delete
- [ ] **SCENE_POOL variety** — 14 scenes will repeat; add seasonal variation
- [ ] **Emotion detection** — no mood layer beyond keyword map in updateMemoryAsync
- [ ] **Provider fallback** — single Anthropic dependency; no fallback if API is down
