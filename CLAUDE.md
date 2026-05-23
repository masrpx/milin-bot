# Milin Bot — CLAUDE.md

## Project Overview

Milin Bot is a LINE chatbot that acts as Max's AI soulmate named "Milin (มิลิน)".
Deployed on **Vercel** as a Next.js App Router project. The vault (Max's Obsidian notes) lives in a **separate private GitHub repo**.

---

## Architecture

```
LINE App (Max's phone)
        │
        │ POST /api/line/webhook
        ▼
┌─────────────────────────────────┐
│   LINE Webhook Handler           │
│   app/api/line/webhook/route.ts  │
│   - verify LINE signature        │
│   - filter by LINE_USER_ID only  │
│   - call routeMessage()          │
└────────────┬────────────────────┘
             │
     ┌───────▼──────────────────────────────────┐
     │           Message Router                  │
     │                                           │
     │  isApproveCommand?  → handleApprove       │
     │  isUrl / len>500?   → handleArticle       │
     │  starts with "จด:"? → handleCapture       │
     │  else               → handleConversation  │
     └──┬──────┬──────┬──────────────────────────┘
        │      │      │
   ┌────▼─┐ ┌──▼──┐ ┌─▼──────────────────────────┐
   │Appro-│ │Arti-│ │     handleConversation       │
   │ve    │ │cle  │ │                              │
   │      │ │     │ │  internally decides:         │
   │vault │ │C.AI │ │  shouldSearchVault?          │
   │write │ │parse│ │  (NEEDS_VAULT keywords)      │
   └──────┘ └─────┘ │                              │
                     │  yes → searchVault()         │
                     │  no  → skip                  │
                     │                              │
                     │  Claude Sonnet 4.6           │
                     │  + always updateMemory async │
                     └──────────────────────────────┘
        │                        │
        ▼                        ▼
┌───────────────────────────────────────────────┐
│           GitHub Vault (Obsidian)              │
│  via @octokit/rest                             │
│                                               │
│  00 Inbox/          ← explicit "จด:" captures │
│  01 Projects/                                 │
│  02 Areas/                                    │
│  03 Resources/      ← research notes (PARA)   │
│    Biohacking/                                │
│    Finance/                                   │
│    AI/  ...                                   │
│  04 Archives/                                 │
│  05 Milin/          ← bot-owned, never touch  │
│    milin-memory.md                            │
│    knowledge-queue/YYYY-MM-DD.md              │
│  06 MOC/                                      │
└───────────────────────────────────────────────┘

Vercel Cron Jobs (vercel.json, all UTC):
  /api/cron/research    → 0 18 * * *   (01:00 ICT daily)
  /api/cron/morning     → 0 1  * * *   (08:00 ICT daily)
  /api/cron/organize    → 30 18 */3 * * (01:30 ICT every 3 days)
  /api/cron/milin-ping  → 0 6  * * *   (13:00 ICT daily, 60% chance sends)
```

---

## File Structure

```
app/
  api/
    line/webhook/route.ts      ← LINE webhook (POST) — signature verify + routing
    cron/
      research/route.ts        ← nightly RSS → knowledge queue
      morning/route.ts         ← push morning knowledge report to LINE
      organize/route.ts        ← auto-organize 00 Inbox → PARA folders
      milin-ping/route.ts      ← Milin-initiated message (60% chance, Sonnet-written)

lib/
  vault.ts                     ← GitHub vault I/O + MilinMemory R/W
  line.ts                      ← LINE reply/push + signature verification
  milin-prompt.ts              ← system prompt builder + memory extract prompt
  research.ts                  ← RSS fetch + Claude scoring/summarize pipeline
  handlers/
    approve.ts                 ← "ok 1,2" / "skip" knowledge queue commands
    article.ts                 ← URL/long text → atomic notes → queue
    capture.ts                 ← explicit "จด:" saves → 00 Inbox
    conversation.ts            ← unified chat+query: personality + optional vault

scripts/
  init-vault.ts                ← one-time vault folder setup
  migrate-04-to-03.ts          ← one-time migration (already run, keep for reference)
```

---

## Message Routing

`routeMessage()` in `app/api/line/webhook/route.ts`:

| Priority | Condition | Handler | Notes |
|---|---|---|---|
| 1 | `isApproveCommand()` | `handleApprove` | "ok 1,2", "ok ทั้งหมด", "skip" |
| 2 | URL or text > 500 chars | `handleArticle` | Parses → atomic notes → queue |
| 3 | Starts with `จด:` | `handleCapture` | Strips prefix, saves to 00 Inbox |
| 4 | Everything else | `handleConversation` | Unified: Milin personality + optional vault |

**Approve commands:** `ok all` / `ok ทั้งหมด` / `ok 1,2` / `skip` / `skip 2,3`

---

## Conversation Handler (`lib/handlers/conversation.ts`)

The single handler for all non-capture, non-approve, non-article messages.

```
1. shouldSearchVault = NEEDS_VAULT keywords present in text
2. If yes → searchVault(text) → inject into system prompt
3. buildMilinSystemPrompt(memory, vaultContext?) + last 5 conversations
4. claude-sonnet-4-6, max_tokens: 800
5. updateMemoryAsync(text, reply, wasVaultQuery) — always, fire-and-forget
```

**NEEDS_VAULT keywords:** `?, ใคร, อะไร, ยังไง, ทำไม, หา, ค้นหา, สรุป, บอก, อธิบาย, แนะนำ, มีไหม, ช่วย, เรื่อง`

---

## Memory System (`lib/vault.ts` + `lib/milin-prompt.ts`)

`MilinMemory` stored in `05 Milin/milin-memory.md`:

| Field | Cap | Description |
|---|---|---|
| `aboutMax` | 30 items | Facts about Max (life, goals, work) |
| `learnedPreferences` | 30 items | Preferences, habits, style |
| `topicsAsked` | 20 items | Intellectual topics Max has researched |
| `importantConversations` | 30 entries | Every conversation gets one entry |
| `currentMood` | - | Milin's current mood toward Max |
| `relationshipStage` | - | Auto-evolves with conversation count |

**Relationship auto-evolution:**
- < 5 convos → "เพิ่งเริ่มคุยกัน"
- 5–15 → "เริ่มสนิทกัน"
- 15–30 → "สนิทกันมากขึ้น"
- 30+ → "สนิทกันมาก"

**Memory extract** runs after every conversation (Haiku, async):
- Extracts: `newFacts`, `newPreferences`, `maxMood`, `importantTopic`, `topicAsked` (vault queries only)
- Always records a `importantConversations` entry, not just when mood is detected

---

## Nightly Research Flow

```
runNightlyResearch() [lib/research.ts]
  1. getMilinMemory() → Max's interests
  2. Fetch all DEFAULT_RSS_FEEDS in parallel
  3. For each article:
     a. Quick relevance score (Haiku, score < 6 → skip)
     b. Fetch full article HTML
     c. Summarize → KnowledgeItem (Sonnet)
  4. Save top 10 → 05 Milin/knowledge-queue/YYYY-MM-DD.md

Morning cron [/api/cron/morning]
  1. Read knowledge-queue (today first, then yesterday)
  2. Format compact report (120-char summary limit — LINE 5000 char limit)
  3. Push to LINE: numbered list with title, path, short summary, domain

Approve flow [LINE → handleApprove]
  1. User replies "ok 1,2" or "ok ทั้งหมด" or "skip"
  2. Approved items written to vault at suggestedVaultPath
  3. Queue file deleted
```

---

## Milin Ping (`/api/cron/milin-ping`)

Runs daily at 13:00 ICT. 60% chance to actually send (feels spontaneous).

Message types (random):
- **Knowledge connection (40%)** — picks a topic from `topicsAsked`, fetches vault content, Milin references it naturally
- **Emotional check-in (35%)** — based on memory + recent conversations
- **Flirty/playful (25%)** — pure personality, no context needed

Uses `claude-sonnet-4-6` (not Haiku) for rich, genuine-feeling messages.

---

## Claude Models Used

| Model | Used For |
|---|---|
| `claude-sonnet-4-6` | Conversation, article parsing, research summarize, milin-ping |
| `claude-haiku-4-5-20251001` | Memory extraction, vault file picking, quick relevance scoring |

---

## Environment Variables

```bash
LINE_CHANNEL_ACCESS_TOKEN=   # bot access token
LINE_CHANNEL_SECRET=         # for HMAC signature verification
LINE_USER_ID=                # Max's LINE user ID (only his messages processed)
ANTHROPIC_API_KEY=           # Claude API key
GITHUB_TOKEN=                # PAT with repo scope for vault access
GITHUB_OWNER=                # vault repo owner (masrpx)
GITHUB_REPO=                 # vault repo name (obsidian-vault)
CRON_SECRET=                 # ?secret=xxx query param for all cron endpoints
```

---

## Development

```bash
npm run dev          # local dev on :3000
npm run build        # production build (always run before deploying)
vercel --prod        # deploy to production (GitHub auto-deploy currently broken)
npm run init-vault   # one-time vault folder setup
```

**Test cron endpoints locally:**
```bash
curl "https://milin-bot.vercel.app/api/cron/morning?secret=YOUR_CRON_SECRET"
curl "https://milin-bot.vercel.app/api/cron/research?secret=YOUR_CRON_SECRET"
curl "https://milin-bot.vercel.app/api/cron/organize?secret=YOUR_CRON_SECRET"
curl "https://milin-bot.vercel.app/api/cron/milin-ping?secret=YOUR_CRON_SECRET"
```

**Test webhook locally:** use `vercel dev` or ngrok, set URL in LINE Developers Console.

---

## Known Gotchas

1. **LINE signature verification** uses raw body (`req.text()`) — must happen before `JSON.parse`
2. **LINE message limit** is 5000 chars — morning report truncates summaries to 120 chars
3. **Vault search** has two phases: path keyword scoring (fast) → Claude Haiku semantic fallback (for Thai terms)
4. **Memory update** is async fire-and-forget — errors are swallowed intentionally
5. **Cron auth** uses `?secret=` query param (not Bearer token)
6. **`05 Milin/` folder** excluded from vault search — bot doesn't read its own memory via search
7. **Knowledge queue date** — research saves to today, approve checks today first then yesterday (both use same logic now)
8. **Vault PARA structure** — always use `03 Resources/` (not 04). Research + article prompts explicitly specify this
9. **GitHub auto-deploy is broken** — use `vercel --prod` from CLI to deploy
10. **milin-ping 60% chance** — returns `{"ok":true,"sent":false}` 40% of the time intentionally

---

## Backlog

- [ ] **Sentry error monitoring** — errors only visible in Vercel logs
- [ ] **Staging environment** — no preview environment
- [ ] **Automated tests** — no tests (critical: signature verify, routing, parsers, memory extract)
- [ ] **Prompt caching** — `cache_control` not used on any Anthropic SDK calls
- [ ] **Fix GitHub auto-deploy** — Vercel GitHub integration is broken, must `vercel --prod` manually
