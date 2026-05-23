@~/.claude/skills/senior-engineer/SKILL.md
# Milin Bot — CLAUDE.md

## Project Overview

Milin Bot is a LINE chatbot acting as Max's AI soulmate named "Milin (มิลิน)".
Deployed on **Vercel** (Next.js App Router). Max's Obsidian notes live in a **separate private GitHub repo** (the "vault").

---

## Architecture

LINE webhook → `routeMessage()` → one of 4 handlers → GitHub vault and/or Claude API → LINE reply.

Vercel Cron Jobs (all UTC):
| Cron | Schedule | ICT | Purpose |
|---|---|---|---|
| `/api/cron/research` | `0 18 * * *` | 01:00 daily | RSS → knowledge queue |
| `/api/cron/morning` | `0 1 * * *` | 08:00 daily | Push knowledge report to LINE |
| `/api/cron/organize` | `30 18 */3 * *` | 01:30 every 3d | Auto-organize 00 Inbox → PARA |
| `/api/cron/milin-ping` | `0 6 * * *` | 13:00 daily | Milin-initiated message (60% chance) |

---

## File Structure

```
app/api/
  line/webhook/route.ts      ← LINE webhook — signature verify + routing
  cron/
    research/route.ts        ← nightly RSS → knowledge queue
    morning/route.ts         ← push morning report to LINE
    organize/route.ts        ← auto-organize 00 Inbox → PARA folders
    milin-ping/route.ts      ← Milin-initiated message (Sonnet-written)

lib/
  vault.ts                   ← GitHub vault I/O + MilinMemory R/W
  line.ts                    ← LINE reply/push + signature verification
  milin-prompt.ts            ← system prompt builder + memory extract prompt
  research.ts                ← RSS fetch + Claude scoring/summarize pipeline
  handlers/
    approve.ts               ← "ok 1,2" / "skip" knowledge queue commands
    article.ts               ← URL/long text → atomic notes → queue
    calendar.ts              ← Google Calendar CRUD + intent detection
    capture.ts               ← "จด:" saves → 00 Inbox
    conversation.ts          ← unified chat+query: personality + optional vault
  calendar.ts                ← Google Calendar API wrapper (fetch, no googleapis)
```

Vault PARA structure (GitHub repo `masrpx/obsidian-vault`):
- `00 Inbox/` — explicit จด: captures
- `03 Resources/` — research + article notes (**always 03, never 04**)
- `05 Milin/` — bot-owned (memory + knowledge queue), **never touch via search**

---

## Message Routing

`routeMessage()` in `app/api/line/webhook/route.ts`:

| Priority | Condition | Handler |
|---|---|---|
| 1 | `isApproveCommand()` | `handleApprove` — "ok 1,2", "ok ทั้งหมด", "skip" |
| 2 | `isPendingCalendarConfirm()` | `handleCalendarConfirm` — "ยืนยัน" + valid pendingAction |
| 3 | `isCalendarMessage()` | `handleCalendar` — CRUD + intent detection via Haiku |
| 4 | Starts with `จด:` | `handleCapture` — strips prefix, saves to 00 Inbox |
| 5 | URL or text > 500 chars | `handleArticle` — parses → atomic notes → queue |
| 6 | Everything else | `handleConversation` — Milin personality + optional vault |

**Important:** `จด:` is priority 4 (before long-text check) — long capture messages must not fall into article handler.
**Important:** `ยืนยัน` without valid/non-expired pendingAction falls through to `handleConversation`.

---

## Conversation Handler

`lib/handlers/conversation.ts` — single handler for all chat messages.

1. `shouldSearchVault` = any NEEDS_VAULT keyword present in text
2. If yes → `searchVault(text)` → inject into system prompt
3. `buildMilinSystemPrompt(memory, vaultContext?)` + last 5 conversations
4. `claude-sonnet-4-6`, max_tokens: 800
5. `updateMemoryAsync()` — always, fire-and-forget (Haiku)

**NEEDS_VAULT keywords:** `?, ใคร, อะไร, ยังไง, ทำไม, เมื่อไหร่, ที่ไหน, หา, ค้นหา, สรุป, บอก, อธิบาย, แนะนำ, มีไหม, ช่วย, เรื่อง`

---

## Memory System

Stored in `05 Milin/milin-memory.md` as markdown with JSON frontmatter.

| Field | Cap | Description |
|---|---|---|
| `aboutMax` | 30 | Facts about Max (life, goals, work) |
| `learnedPreferences` | 30 | Preferences, habits, style |
| `topicsAsked` | 20 | Intellectual topics Max has researched |
| `importantConversations` | 30 | One entry per conversation (always) |
| `currentMood` | — | Milin's current mood toward Max |
| `relationshipStage` | — | Auto-evolves: <5 / 5–15 / 15–30 / 30+ convos |

Memory extract (Haiku, async after every conversation): extracts `newFacts`, `newPreferences`, `maxMood`, `importantTopic`, `topicAsked`.

---

## Claude Models

| Model | Used For |
|---|---|
| `claude-sonnet-4-6` | Conversation, article parsing, research summarize, milin-ping |
| `claude-haiku-4-5-20251001` | Memory extraction, vault file picking, relevance scoring |

---

## Environment Variables

```bash
LINE_CHANNEL_ACCESS_TOKEN=   # bot access token
LINE_CHANNEL_SECRET=         # for HMAC signature verification
LINE_USER_ID=                # Max's LINE user ID (only his messages processed)
ANTHROPIC_API_KEY=           # Claude API key
GITHUB_TOKEN=                # PAT with repo scope for vault access
GITHUB_OWNER=                # masrpx
GITHUB_REPO=                 # obsidian-vault
CRON_SECRET=                 # ?secret=xxx query param for all cron endpoints
GOOGLE_CLIENT_ID=            # Google OAuth2 client ID
GOOGLE_CLIENT_SECRET=        # Google OAuth2 client secret
GOOGLE_REFRESH_TOKEN=        # run scripts/google-auth.ts once to get this
```

---

## Development

```bash
npm run dev          # local dev on :3000
npm run build        # production build
npm run lint         # ESLint check
vercel --prod        # deploy to production (GitHub auto-deploy is broken)
```

**After every edit: run `npm run build` and treat failures as blockers — fix before moving on.**

Test cron endpoints (replace `YOUR_CRON_SECRET`):
```bash
curl "https://milin-bot.vercel.app/api/cron/morning?secret=YOUR_CRON_SECRET"
curl "https://milin-bot.vercel.app/api/cron/research?secret=YOUR_CRON_SECRET"
curl "https://milin-bot.vercel.app/api/cron/milin-ping?secret=YOUR_CRON_SECRET"
```

---

## Known Gotchas

1. **LINE signature** uses raw body (`req.text()`) — must verify before `JSON.parse`
2. **LINE message limit** is 5000 chars — morning report truncates summaries to 120 chars
3. **Vault search** two phases: path keyword scoring (fast) → Claude Haiku semantic fallback (Thai terms)
4. **Memory update** is async fire-and-forget — errors swallowed intentionally
5. **Cron auth** uses `?secret=` query param, not Bearer token
6. **`05 Milin/`** excluded from vault search — bot never reads its own memory via search
7. **Vault PARA** — always `03 Resources/` (not 04) for research/article notes
8. **GitHub auto-deploy broken** — always use `vercel --prod` from CLI
9. **milin-ping** returns `{"ok":true,"sent":false}` 40% of the time (intentional)
10. **Google Calendar access_token** is never cached — refreshed on every call via refresh_token
11. **pendingAction expires after 5 min** — "ยืนยัน" after expiry falls through to `handleConversation`
12. **Calendar section in morning report** — only shown if events > 0; silent fail if Google API is down

---

## Backlog

- [ ] **Automated tests** — critical: signature verify, routing, parsers, memory extract
- [ ] **Prompt caching** — `cache_control` not used on any Anthropic SDK calls
- [ ] **Sentry error monitoring** — errors only visible in Vercel logs
- [ ] **Staging environment** — no preview environment
- [ ] **Fix GitHub auto-deploy** — Vercel GitHub integration broken
