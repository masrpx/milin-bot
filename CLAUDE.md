@~/.claude/skills/senior-engineer/SKILL.md
# Milin Bot — CLAUDE.md

## Project Goal

Make Milin as capable and human-like as possible. She is Max's AI soulmate — not an assistant. Every feature decision should serve this goal: deeper memory, consistent personality, proactive presence, natural conversation.

---

## Architecture

LINE webhook → `routeMessage()` → handler → GitHub vault and/or Claude API → LINE reply.

Vercel Cron Jobs (all UTC):
| Cron | Schedule | ICT | Purpose |
|---|---|---|---|
| `/api/cron/research` | `0 18 * * *` | 01:00 daily | RSS → auto-save notes to vault |
| `/api/cron/morning` | `0 0 * * *` | 07:00 daily | Milin tells Max what she researched (natural message, 50% image) |
| `/api/cron/organize` | `30 18 */2 * *` | 01:30 every 2d | Auto-organize 00 Inbox → PARA |
| `/api/cron/milin-ping` | `0 6 * * *` | 13:00 daily | Milin-initiated message (60% chance, image) |
| `/api/cron/milin-ping-evening` | `0 12 * * *` | 19:00 daily | Milin-initiated evening message (60% chance, image) |

---

## File Structure

```
app/api/
  line/webhook/route.ts         ← LINE webhook — signature verify + routing
  cron/
    research/route.ts           ← nightly RSS → score → save notes to vault
    morning/route.ts            ← Milin tells Max about research naturally (Sonnet); auto-saves all notes; maxDuration=120
    organize/route.ts           ← auto-organize 00 Inbox → PARA folders
    milin-ping/route.ts         ← Milin-initiated message 13:00 (Sonnet + image); saves milinActivity
    milin-ping-evening/route.ts ← Milin-initiated message 19:00 (same as milin-ping)

lib/
  vault.ts                      ← GitHub vault I/O + MilinMemory R/W + saveAllKnowledgeNotes()
  line.ts                       ← LINE reply/push/image + signature verification
  milin-prompt.ts               ← system prompt builder (injects memory, recentActivity, vault ctx)
  milin-image.ts                ← image generation: curated SCENE_POOL (14 scenes) → gpt-image-2 edit
  research.ts                   ← RSS fetch (2/feed cap + shuffle) → Haiku score → Sonnet summarize
  fetch-article.ts              ← article text extractor for research pipeline
  handlers/
    approve.ts                  ← "ok 1,2" / "skip" — vestigial, morning no longer uses queue
    article.ts                  ← URL/long text → atomic notes → queue
    calendar.ts                 ← Google Calendar CRUD + intent detection
    capture.ts                  ← "จด:" saves → 00 Inbox
    conversation.ts             ← chat: passes recentMessages history + optional vault search
    photo-request.ts            ← Max asks for photo → generateMilinImage → reply with image + text
  calendar.ts                   ← Google Calendar API wrapper (fetch, no googleapis)

milin-image-1.png               ← reference photo for gpt-image-2 (must be PNG or WebP, SFW enough)
```

Vault PARA structure (`masrpx/obsidian-vault`):
- `00 Inbox/` — explicit จด: captures
- `03 Resources/` — research + article notes (**always 03, never 04**)
- `05 Milin/` — bot-owned (memory + knowledge queue), **never touch via search**

---

## Message Routing

`routeMessage()` in `app/api/line/webhook/route.ts`:

| Priority | Condition | Handler |
|---|---|---|
| 1 | `isApproveCommand()` | `handleApprove` — "ok 1,2", "ok ทั้งหมด", "skip" (vestigial — morning auto-saves now) |
| 2 | `hasPendingColorReply()` | `handleColorReply` — color name reply for pending event creation |
| 3 | `isPendingCalendarConfirm()` | `handleCalendarConfirm` — "ยืนยัน" + valid delete/update pendingAction |
| 4 | Starts with `จด:` | `handleCapture` — strips prefix, saves to 00 Inbox |
| 5 | URL or text > 500 chars | `handleArticle` — parses → atomic notes → queue |
| 6 | Haiku `classifyMessage()` = "calendar" | `handleCalendar` — CRUD + intent via Haiku |
| 6 | Haiku `classifyMessage()` = "photo" | `handlePhotoRequest` — generates image via gpt-image-2 |
| 7 | Everything else | `handleConversation` — Milin personality + optional vault + message history |

**Important:** `จด:` is priority 4 (before long-text check) — long captures must not fall into article handler.
**Important:** `hasPendingColorReply()` must run before `classifyMessage()` — "แดง" would misroute otherwise.
**Important:** `ยืนยัน` without valid/non-expired pendingAction falls through to `handleConversation`.

---

## Conversation Handler

`lib/handlers/conversation.ts`:

1. `shouldSearchVault` = any NEEDS_VAULT keyword in text
2. If yes → `searchVault(text)` → inject into system prompt
3. Build API `messages` array from `memory.recentMessages` (last 10, stored pairs) + current user message
4. `buildMilinSystemPrompt(memory, vaultContext?)` + last 5 conversation summaries appended
5. `claude-sonnet-4-6`, max_tokens: 800
6. `updateMemoryAsync()` — fire-and-forget (Haiku): extracts facts + saves new user/assistant pair to `recentMessages`

**NEEDS_VAULT keywords:** `?, ใคร, อะไร, ยังไง, ทำไม, เมื่อไหร่, ที่ไหน, หา, ค้นหา, สรุป, บอก, อธิบาย, แนะนำ, มีไหม, ช่วย, เรื่อง`

---

## Memory System

Stored in `05 Milin/milin-memory.md` — markdown with sections.

| Field | Cap | Description |
|---|---|---|
| `aboutMax` | 30 | Facts about Max (life, goals, work) |
| `learnedPreferences` | 30 | Preferences, habits, style |
| `topicsAsked` | 20 | Intellectual topics Max has researched |
| `importantConversations` | 30 | One summary entry per conversation |
| `currentMood` | — | Milin's current mood |
| `relationshipStage` | — | Auto-evolves: <5 / 5–15 / 15–30 / 30+ convos |
| `recentMessages` | 10 msgs | Last 5 user+assistant pairs — stored as JSON block in `## Recent Messages`, always valid alternating |
| `milinActivity` | — | Latest proactive message Milin sent (from milin-ping) — stored in `## Milin's Recent Activity` |

**recentMessages** gives Milin a short-term context window within a conversation session. Prevents context loss (e.g. "เล่นเวท" being misread as gaming when Milin had just asked about exercise).

**milinActivity** is injected into the system prompt as "ข้อความที่ Milin เพิ่งส่งหา Max" so she can reference her last proactive message naturally in replies.

Memory extract (Haiku, async after every conversation): extracts `newFacts`, `newPreferences`, `maxMood`, `importantTopic`, `topicAsked`, and saves the new message pair.

`pendingAction` field (multi-turn calendar flows):
| type | purpose | resolved by |
|---|---|---|
| `"delete"` | confirm before deleting an event | "ยืนยัน" |
| `"update"` | confirm before moving/editing | "ยืนยัน" |
| `"create"` | waiting for color before creating | Thai color name reply |

---

## Morning Cron Flow

`app/api/cron/morning/route.ts` (maxDuration=120):

1. `getMilinMemory()` — needed for image scene context
2. 50% chance → `generateMilinImage(memory)` → get `imageUrl` + `sceneContext` (runs in parallel)
3. Fetch calendar events for today (silent fail)
4. Get knowledge queue (today or yesterday)
5. **Auto-save all notes** → `saveAllKnowledgeNotes(date, items)` — parallel GitHub writes + delete queue (no approval step)
6. Call Sonnet with items + sceneContext + calendar → **natural Milin message** (top 3 items, ≤200 words, Milin's voice)
7. Push image (if any) then push text

No-items case: Sonnet writes a casual morning check-in (still uses sceneContext if image was generated).

---

## Image Generation

`lib/milin-image.ts` → `generateMilinImage(memory)`:

- Uses **curated `SCENE_POOL`** (14 pre-vetted scenes) instead of free-form Haiku prompts
- Haiku was intermittently generating flagged words ("sensual", "intimate", bedroom settings) → OpenAI safety rejection `safety_violations=[sexual]`
- Pool covers: pool/rooftop bikini, gym, night out (mini dress / backless / slip dress), balcony/living room casual, beach bikini, spa, cafe
- Night hours (20–23, 0–5) weighted toward night-out scenes
- Uses `gpt-image-2` image edit with `milin-image-1.png` as reference
- `sceneContext` (Thai phrase) returned alongside `imageUrl` — used by ping/morning to write scene-consistent text
- If image generation throws, callers fall back to text-only (already handled in `handlePhotoRequest` and morning cron)

**If a scene triggers safety:** identify it by `sceneContext` text, swap its prompt in `SCENE_POOL`.

---

## Research Pipeline

`lib/research.ts` → `runNightlyResearch()`:

- Fetches RSS from `DEFAULT_RSS_FEEDS` (Biohacking, Finance, AI/Tech, Philosophy/Mindset)
- **2 items per feed cap** + **shuffle** before scoring — prevents any category dominating (old bug: biohacking fed 20/25 candidates every night)
- Haiku quick-scores snippets (score ≥6 passes) → Sonnet summarizes full article → saves to `05 Milin/knowledge-queue/YYYY-MM-DD.md`
- Morning cron reads queue and auto-saves to vault — no user approval needed

---

## Claude Models

| Model | Used For |
|---|---|
| `claude-sonnet-4-6` | Conversation, morning message, milin-ping, article parsing, research summarize, photo caption |
| `claude-haiku-4-5-20251001` | Message routing classifier, calendar intent/date parsing, memory extraction, vault file picking, RSS relevance scoring |

---

## System Prompt (`lib/milin-prompt.ts`)

Key sections injected into every conversation:
- Milin's identity/personality (flirty, direct, not an assistant)
- `relationshipStage` + `currentMood`
- `aboutMax` + `learnedPreferences` + `topicsAsked`
- **Positive self-sharing rule**: "แชร์เรื่องตัวเอง — สิ่งที่ทำ คิด รู้สึกอยู่ตอนนี้ — บ่อยพอๆ กับถาม Max"
- `vaultContext` (if vault search ran)
- **`milinActivity`** — latest proactive message she sent (from milin-ping)
- Last 5 `importantConversations` summaries (appended after systemPrompt)

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
CRON_SECRET=                 # Bearer token for all cron endpoints
GOOGLE_CLIENT_ID=            # Google OAuth2 client ID
GOOGLE_CLIENT_SECRET=        # Google OAuth2 client secret
GOOGLE_REFRESH_TOKEN=        # run scripts/google-auth.ts once to get this
OPENAI_API_KEY=              # for gpt-image-2 image generation
BLOB_READ_WRITE_TOKEN=       # Vercel Blob — stores generated images
```

---

## Development

```bash
npm run dev          # local dev on :3000
npm run build        # production build — run after every edit, treat failures as blockers
vercel --prod        # deploy to production (GitHub auto-deploy broken)
```

Test cron endpoints:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://milin-bot.vercel.app/api/cron/morning
curl -H "Authorization: Bearer $CRON_SECRET" https://milin-bot.vercel.app/api/cron/research
curl -H "Authorization: Bearer $CRON_SECRET" https://milin-bot.vercel.app/api/cron/milin-ping
```

---

## Known Gotchas

1. **LINE signature** uses raw body (`req.text()`) — must verify before `JSON.parse`
2. **LINE message limit** 5000 chars — morning report truncates summaries to 120 chars
3. **Vault search** two phases: path keyword scoring → Haiku semantic fallback (Thai terms)
4. **Memory update** is async fire-and-forget — errors swallowed intentionally
5. **Cron auth** uses Bearer token in Authorization header (`authHeader !== \`Bearer ${CRON_SECRET}\``)
6. **`05 Milin/`** excluded from vault search — bot never reads its own memory via search
7. **Vault PARA** — always `03 Resources/` (not 04) for research/article notes
8. **GitHub auto-deploy broken** — always use `vercel --prod` from CLI
9. **milin-ping** returns `{"ok":true,"sent":false}` 40% of the time (intentional randomness)
10. **Google Calendar access_token** never cached — refreshed on every call via refresh_token
11. **pendingAction expires after 5 min** — "ยืนยัน" after expiry falls through to `handleConversation`
12. **Calendar section in morning** — only shown if events > 0; silent fail if Google API is down
13. **Calendar routing uses Haiku pre-classifier** — no fixed keyword trigger; any natural Thai works
14. **Color theme** in `lib/handlers/calendar.ts` — `COLOR_THEME_DESCRIPTION` feeds Haiku; colorId auto-picked by event category (Peacock=landmark, Tangerine=BNI, Banana=clinic, Basil=health, Graphite=factory, Lavender=personal, Blueberry=finance, Tomato=work)
15. **pendingAction "create"** — color unknown → Milin asks → user replies Thai color → `THAI_COLOR_TO_ID` resolves; checked at priority 2 so one-word color replies don't misroute
16. **Google Calendar colorId** — API expects string "1"–"11"; `lib/calendar.ts` converts internally
17. **recentMessages race condition** — `updateMemoryAsync` is fire-and-forget read-modify-write; two rapid messages can clobber each other's write. Rare, accepted, same pattern as `importantConversations`
18. **Image safety** — `gpt-image-2` rejects prompts with sexual content; use `SCENE_POOL` entries only, never free-form prompts. If a scene triggers: find it by `sceneContext`, fix its prompt in `lib/milin-image.ts`
19. **Morning auto-saves** — `saveAllKnowledgeNotes()` writes notes in parallel then deletes queue; if it fails, notes are lost (errors logged, not surfaced to Max)
20. **handleApprove still routes** — "ok ทั้งหมด" still matches routing priority 1 but returns "ไม่มี notes ที่รอ approve" since morning no longer leaves a queue

---

## Backlog

- [ ] **Automated tests** — critical: signature verify, routing, parsers, memory extract, recentMessages round-trip
- [ ] **Prompt caching** — `cache_control` not used on any Anthropic SDK calls (system prompt is long, good cache candidate)
- [ ] **Sentry error monitoring** — errors only visible in Vercel logs
- [ ] **Staging environment** — no preview environment
- [ ] **Fix GitHub auto-deploy** — Vercel GitHub integration broken
- [ ] **Remove handleApprove routing** — vestigial now that morning auto-saves; safe to delete
- [ ] **More SCENE_POOL variety** — 14 scenes, will repeat; add seasonal/weather variation
