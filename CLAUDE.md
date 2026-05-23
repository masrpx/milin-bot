# Milin Bot — CLAUDE.md

## Project Overview

Milin Bot เป็น LINE chatbot ที่ทำหน้าที่เป็น AI soulmate ของ Max ชื่อ "Milin (มิลิน)"
Deploy บน **Vercel** เป็น Next.js App Router project ส่วน vault เก็บไว้ใน **GitHub repo แยกต่างหาก** (Obsidian vault ของ Max)

---

## Architecture

```
LINE App (Max's phone)
        │
        │ POST /api/line/webhook
        ▼
┌─────────────────────────────┐
│   LINE Webhook Handler       │
│   app/api/line/webhook/      │
│   - verify signature         │
│   - filter by LINE_USER_ID   │
│   - call routeMessage()      │
└────────────┬────────────────┘
             │
     ┌───────▼────────────────────────────┐
     │       Message Router               │
     │  (in webhook/route.ts)             │
     │                                    │
     │  isApproveCommand? → handleApprove │
     │  isUrl / long text? → handleArticle│
     │  isQuestion?        → handleQuery  │
     │  isChat?            → handleChat   │
     │  else               → handleCapture│
     └──┬──────┬──────┬──────┬───────────┘
        │      │      │      │
   ┌────▼─┐ ┌──▼──┐ ┌─▼───┐ ┌▼──────────┐
   │Appro-│ │Arti-│ │Query│ │Chat/      │
   │ve    │ │cle  │ │     │ │Capture    │
   │      │ │     │ │     │ │           │
   │vault │ │C.AI │ │vault│ │Claude AI  │
   │write │ │parse│ │read │ │Sonnet 4.6 │
   └──────┘ └─────┘ └─────┘ └───────────┘
        │                │
        ▼                ▼
┌───────────────────────────────────────┐
│         GitHub Vault (Obsidian)        │
│  via @octokit/rest                     │
│                                        │
│  00 Inbox/          ← quick captures  │
│  01 Daily/          ← daily notes     │
│  04 Resources/      ← organized notes │
│  05 Milin/          ← bot memory +    │
│    ├─ milin-memory.md                  │
│    └─ knowledge-queue/YYYY-MM-DD.md   │
│  06 MOC/            ← maps of content │
└───────────────────────────────────────┘

Vercel Cron Jobs (vercel.json):
  /api/cron/research   → 01:00 UTC daily   (= 08:00 ICT)
  /api/cron/morning    → 08:00 UTC daily   (= 15:00 ICT? check TZ)
  /api/cron/organize   → 01:30 UTC */3days
```

> **หมายเหตุ Cron:** vercel.json ใช้ UTC — `0 18 * * *` = 01:00 ICT, `0 1 * * *` = 08:00 ICT

---

## File Structure

```
app/
  api/
    line/webhook/route.ts   ← LINE webhook endpoint (POST)
    cron/
      research/route.ts     ← nightly RSS → knowledge queue
      morning/route.ts      ← push morning report to LINE
      organize/route.ts     ← auto-organize 00 Inbox → PARA folders
  page.tsx                  ← placeholder homepage (unused)

lib/
  vault.ts                  ← GitHub vault I/O + memory R/W
  line.ts                   ← LINE reply/push + signature verify
  milin-prompt.ts           ← system prompt builder + memory extractor
  research.ts               ← RSS fetch + Claude scoring/summarize
  handlers/
    approve.ts              ← "ok 1,2" / "skip" commands
    article.ts              ← URL/long text → atomic notes
    capture.ts              ← save to 00 Inbox
    chat.ts                 ← free chat + async memory update
    query.ts                ← vault search + Claude answer

scripts/
  init-vault.ts             ← one-time vault folder setup
```

---

## Message Routing Logic

`routeMessage()` ใน `app/api/line/webhook/route.ts` ตรวจตามลำดับนี้:

| Priority | Condition | Handler | Action |
|---|---|---|---|
| 1 | `isApproveCommand()` | `handleApprove` | Parse "ok 1,2" / "skip" → write to vault |
| 2 | URL pattern or text > 500 chars | `handleArticle` | Fetch + parse → atomic notes queue |
| 3 | Contains question keywords | `handleQuery` | Search vault → Claude answers |
| 4 | Contains chat keywords | `handleChat` | Claude Sonnet chat + async memory |
| 5 | Everything else | `handleCapture` | Save to `00 Inbox/` |

**Approve commands:**
- `ok all` / `ok ทั้งหมด` — approve everything
- `ok 1,2` — approve specific items
- `skip` / `ข้ามทั้งหมด` — delete queue
- `skip 2,3` — skip specific, approve rest

---

## Nightly Research Flow

```
runNightlyResearch() [lib/research.ts]
  1. getMilinMemory() → get Max's interests
  2. Fetch all DEFAULT_RSS_FEEDS in parallel
  3. For each item:
     a. Quick score with Haiku (< 6 → skip)
     b. Fetch full article HTML
     c. Summarize with Sonnet → KnowledgeItem
  4. Save top 10 → 05 Milin/knowledge-queue/YYYY-MM-DD.md

Morning cron [/api/cron/morning]
  1. Read knowledge-queue for today (then yesterday)
  2. Push formatted report to LINE
  3. Max replies with ok/skip commands
```

---

## Claude Models Used

| Model | Used For | Why |
|---|---|---|
| `claude-sonnet-4-6` | Chat, query answers, article parsing | Quality required |
| `claude-haiku-4-5-20251001` | Quick relevance scoring, memory extraction, vault file picking | Speed/cost |

---

## Environment Variables

```bash
# LINE
LINE_CHANNEL_ACCESS_TOKEN=   # bot access token
LINE_CHANNEL_SECRET=         # for signature verification
LINE_USER_ID=                # Max's LINE user ID (only his messages processed)

# Anthropic
ANTHROPIC_API_KEY=           # Claude API key

# GitHub Vault
GITHUB_TOKEN=                # personal access token (repo scope)
GITHUB_OWNER=                # vault repo owner (masrpx)
GITHUB_REPO=                 # vault repo name

# Security
CRON_SECRET=                 # random secret for cron endpoints (?secret=xxx)
```

---

## Vault Structure (GitHub Repo)

Obsidian vault ของ Max ใช้ **PARA method:**

```
00 Inbox/              ← quick captures, auto-organized every 3 days
01 Daily/              ← daily notes
02 Areas/              ← ongoing areas of responsibility
03 Projects/           ← active projects
04 Resources/          ← reference knowledge
  Biohacking/
  Finance/
  AI/
  ...
05 Milin/              ← bot-owned files (DO NOT touch manually)
  milin-memory.md      ← Milin's memory about Max
  knowledge-queue/     ← pending items for morning approval
06 MOC/                ← maps of content
```

---

## Development

```bash
npm run dev          # start local dev server on :3000
npm run build        # production build
npm run lint         # eslint check
npm run init-vault   # one-time vault setup (creates folder structure)
```

**Testing cron locally:**
```bash
curl "http://localhost:3000/api/cron/morning?secret=your_cron_secret"
curl "http://localhost:3000/api/cron/research?secret=your_cron_secret"
```

**Testing webhook locally:** ใช้ [ngrok](https://ngrok.com/) หรือ `vercel dev`
```bash
ngrok http 3000
# แล้วตั้ง webhook URL ใน LINE Developers Console
```

---

## Known Gotchas

1. **LINE signature verification** ใช้ raw body (`req.text()`) ต้องทำก่อน `JSON.parse`
2. **Vault search** มี 2 ขั้นตอน: path keyword scoring (เร็ว) → Claude file picker (fallback สำหรับ Thai queries)
3. **Memory update** เป็น async fire-and-forget — error ไม่ surface ไปยัง user
4. **Cron auth** ใช้ `?secret=` query param — ไม่ใช่ Bearer token
5. **`05 Milin/` folder** ถูก exclude จาก vault search เพื่อป้องกัน bot อ่าน memory ตัวเอง
6. **Knowledge queue** อิง date offset: research เก็บวันนี้, morning cron อ่านวันนี้ก่อน แล้ว fallback เมื่อวาน
7. **vercel.json crons** ทำงานเฉพาะ production deployment (ไม่ทำงานใน preview)

---

## What's NOT Done Yet (Backlog)

- [ ] **Sentry error monitoring** — errors ตอนนี้ดูได้แค่ Vercel logs
- [ ] **Staging environment** — ตอนนี้มีแค่ production
- [ ] **Automated tests** — ไม่มี test ไฟล์เลย (critical: signature verify, router, parsers)
- [ ] **Prompt caching** — Anthropic SDK calls ยังไม่ใช้ cache_control
- [ ] **Rate limiting** — webhook ไม่มี rate limit
