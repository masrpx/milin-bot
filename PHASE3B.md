# Milin Phase 3B — Google Calendar Integration
# Agent PRD (Pattern A: Separation of Concern)

---

## Context (อ่านก่อนทุก agent)

Milin Bot คือ LINE chatbot ที่ deploy บน Vercel (Next.js App Router)
Vault = GitHub repo `masrpx/obsidian-vault` เข้าถึงผ่าน `@octokit/rest`
Stack: TypeScript, Next.js App Router, Vercel Cron, Anthropic SDK

Routing ปัจจุบัน (priority order):
  1. isApproveCommand() → handleApprove
  2. isUrl / len>500     → handleArticle
  3. starts "จด:"        → handleCapture
  4. else                → handleConversation

Cron ที่มีอยู่:
  /api/cron/morning  → 0 1 * * * (08:00 ICT) ← จะเพิ่ม calendar ที่นี่

Known Gotchas ที่ทุก agent ต้องรู้:
- LINE signature ต้องใช้ raw body (req.text()) ก่อน JSON.parse เสมอ
- LINE message limit 5000 chars
- Cron auth ใช้ ?secret= query param
- GitHub auto-deploy broken → ใช้ vercel --prod

---

## New Env Vars (ต้องมีก่อน implement)

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=   # one-time OAuth flow → scripts/google-auth.ts
```

---

## PLANNER INPUT
> อ่าน PRD นี้ทั้งหมด → output: task list + dependencies ที่ชัดเจน

### Feature Scope

**F1: lib/calendar.ts** — Google Calendar API wrapper
- getAccessToken() → refresh OAuth token ทุก call
- getEvents(startISO, endISO) → CalendarEvent[]
- createEvent(title, startISO, endISO, description?) → eventId
- updateEvent(eventId, changes) → void
- deleteEvent(eventId) → void
- findFreeSlots(startISO, endISO, durationMin) → TimeSlot[]

**F2: lib/handlers/calendar.ts** — Calendar handler
- detectCalendarIntent(text) → intent: read | create | update | delete | suggest
- handleCalendar(text, replyToken) → void
- delete/update intent: reply confirm message ก่อน → รอ user reply "ยืนยัน"
- pending confirm state เก็บใน milin-memory.md field: pendingAction

**F3: routeMessage() update** — เพิ่ม calendar routing
- Priority 1.5 (หลัง approve, ก่อน article)
- CALENDAR_KEYWORDS: นัด|ตาราง|ว่าง|เจอ|ประชุม|ยกเลิก|เลื่อน|พรุ่งนี้|อาทิตย์นี้|สัปดาห์หน้า|วันนี้มีอะไร
- ถ้า match → handleCalendar()
- ถ้า pendingAction ใน memory → handleCalendarConfirm()

**F4: morning cron update** — เพิ่ม today's events
- เรียก getEvents(todayStart, todayEnd)
- format: "📅 วันนี้: [time] [title]" แต่ละ event 1 บรรทัด
- append ก่อน knowledge queue ใน morning report
- ถ้า getEvents fail → skip silently (ไม่ให้ morning report พัง)

**F5: scripts/google-auth.ts** — one-time OAuth setup script
- รัน locally → เปิด browser → authorize → print refresh_token
- ไม่ deploy บน Vercel

---

## PLANNER OUTPUT FORMAT

```
TASK_ID | depends_on | file | description
T01     | -          | lib/calendar.ts              | สร้าง Google Calendar wrapper ทั้งหมด
T02     | T01         | lib/handlers/calendar.ts     | สร้าง calendar handler + intent detection
T03     | T02         | lib/vault.ts                 | เพิ่ม pendingAction field ใน MilinMemory type
T04     | T01,T03     | app/api/line/webhook/route.ts| เพิ่ม calendar routing priority 1.5
T05     | T01         | app/api/cron/morning/route.ts| เพิ่ม today's events ใน morning report
T06     | -           | scripts/google-auth.ts       | one-time OAuth setup script
T07     | T01-T06     | vercel.json + .env.example   | เพิ่ม env vars documentation
```

---

## CODER INPUT
> รับ 1 task จาก PLANNER → output: code files only ห้าม review หรือแก้ task อื่น

### Constraints ที่ CODER ต้องตาม

```typescript
// calendar.ts pattern
export async function getAccessToken(): Promise<string> {
  // POST to https://oauth2.googleapis.com/token
  // grant_type: refresh_token
  // client_id, client_secret, refresh_token จาก env
  // return access_token
}

// CalendarEvent type
type CalendarEvent = {
  id: string
  title: string
  startISO: string
  endISO: string
  description?: string
}

// TimeSlot type
type TimeSlot = {
  startISO: string
  endISO: string
}

// intent detection ใช้ keyword matching ก่อน → Haiku fallback ถ้าไม่ชัด
// ห้ามใช้ Sonnet สำหรับ intent detection (cost)

// pendingAction ใน MilinMemory
type PendingAction = {
  type: 'delete' | 'update'
  eventId: string
  eventTitle: string
  changes?: Partial<CalendarEvent>
  expiresAt: string // ISO — expire หลัง 5 นาที
}

// Milin response tone ตัวอย่าง:
// create: "โอเคนะ จัดให้เลย 📅 [title] [date] [time] บันทึกแล้วค่ะ"
// delete confirm: "จะลบ '[title]' ใช่มั้ยคะ? ตอบ 'ยืนยัน' ถึงจะลบนะ"
// suggest: "ดูแล้วมีว่างช่วง [time]-[time] กับ [time]-[time] ค่ะ"
```

---

## REVIEWER INPUT
> รับ code จาก CODER → output: issues list เท่านั้น ห้ามแก้โค้ดเอง

### Checklist ที่ REVIEWER ต้องเช็ค

**Security**
- [ ] GOOGLE_CLIENT_SECRET ไม่ถูก log หรือ expose
- [ ] access_token ไม่ถูกเก็บใน memory/vault (refresh ทุก call)
- [ ] pendingAction expire check ก่อน execute เสมอ

**Reliability**
- [ ] getEvents fail → morning cron ยังทำงานต่อได้ (silent fail)
- [ ] Calendar API rate limit → error message ที่ user อ่านได้
- [ ] OAuth token expire → refresh ก่อน retry อัตโนมัติ

**Routing**
- [ ] CALENDAR_KEYWORDS ไม่ชน NEEDS_VAULT keywords (conversation handler)
- [ ] pendingAction check ทำก่อน keyword match
- [ ] pendingAction expired → clear และ treat เป็น message ปกติ

**LINE**
- [ ] Morning report หลังเพิ่ม events ยังไม่เกิน 5000 chars
- [ ] ถ้า 0 events วันนี้ → ไม่แสดง section calendar (ไม่ใช่ "ไม่มีนัด")

**Types**
- [ ] MilinMemory type อัพเดตครบทุกที่ที่ใช้ (vault.ts + milin-prompt.ts)
- [ ] npm run build → 0 errors

---

## FIXER INPUT
> รับ issues list จาก REVIEWER → output: fixed code files เท่านั้น
> แก้เฉพาะ issues ที่ระบุ ห้าม refactor นอกเหนือ scope

---

## TESTER INPUT
> รับ fixed code → output: pass/fail report

### Test Cases

```
TC01 | "พรุ่งนี้มีอะไรบ้าง"
  → intent: read
  → getEvents(tomorrow_start, tomorrow_end) ถูกเรียก
  → reply มี event list หรือ "ว่างทั้งวันเลยนะ" ถ้าไม่มี

TC02 | "นัด BNI ศุกร์นี้ 9 โมง ครึ่งชั่วโมง"
  → intent: create
  → createEvent("BNI", friday_09:00, friday_09:30) ถูกเรียก
  → reply confirm ชื่อ + เวลา ถูกต้อง

TC03 | "ยกเลิกนัดพรุ่งนี้กับหมอ"
  → intent: delete
  → Milin reply confirm ก่อน ("จะลบ 'X' ใช่มั้ย?")
  → ยังไม่ deleteEvent
  → Max reply "ยืนยัน" → deleteEvent ถูกเรียก

TC04 | "ยืนยัน" โดยไม่มี pendingAction หรือ expired
  → treat เป็น message ปกติ → handleConversation

TC05 | "หาเวลาว่างอาทิตย์หน้าสัก 1 ชั่วโมง"
  → intent: suggest
  → findFreeSlots ถูกเรียก
  → reply มี slot อย่างน้อย 1 ช่วง

TC06 | Morning cron เมื่อ getEvents throw error
  → morning report ส่งได้ปกติ (ไม่มี calendar section)
  → ไม่ crash

TC07 | Morning cron เมื่อมี 3 events วันนี้
  → report มี 3 events ก่อน knowledge queue
  → total chars < 5000

TC08 | npm run build
  → 0 errors, 0 type errors
```

### TESTER Output Format
```
TC01 | PASS | -
TC02 | FAIL | createEvent ส่ง timezone ผิด (UTC แทน ICT)
TC03 | PASS | -
...
OVERALL: X/8 passed
```

---

## Definition of Done

- [ ] TC01–TC08 ทั้งหมด PASS
- [ ] npm run build → 0 errors
- [ ] CLAUDE.md อัพเดต (routing table, env vars, known gotchas)
- [ ] .env.example เพิ่ม 3 Google vars
- [ ] vercel --prod deploy สำเร็จ
