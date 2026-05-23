<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Instructions — Milin Bot

## Stack & Version Notes

- **Next.js 16.2.6** (App Router) — all routes are Route Handlers, not `pages/api/`
- **React 19.2.4** — concurrent features default-on
- **`@anthropic-ai/sdk` `^0.98.0`** — use `client.messages.create()` only

## Key Conventions

- Env vars: `process.env.VAR_NAME` directly — no dotenv in runtime code
- TypeScript strict: no `any` casts
- Errors: catch silently only in fire-and-forget paths (e.g. `updateMemoryAsync`); surface in cron/webhook via `console.error` + 500 response
- Deploy: `vercel --prod` (GitHub auto-deploy is broken — do not rely on git push)

## Critical Architecture Rules

- **Routing lives only in `app/api/line/webhook/route.ts`** — handlers do not decide routing
- **`handleConversation` is the default handler** — replaces old `handleChat` + `handleQuery`
- **Vault search is internal to `conversation.ts`** — decided by `NEEDS_VAULT` keywords, not by the router
- **Memory updates on every conversation** — `updateMemoryAsync` is always called in `handleConversation`
- **Vault PARA structure**: always `03 Resources/` — never `04 Resources/`

## Do NOT

- Do NOT call `JSON.parse` on `req.body` in webhook — always `req.text()` first (LINE signature requires raw body)
- Do NOT read/write `05 Milin/` folder except through `lib/vault.ts`
- Do NOT add new Sonnet calls where Haiku suffices (scoring/extraction tasks)
- Do NOT add `use client` to API routes or lib files
- Do NOT recreate `chat.ts` or `query.ts` — they are intentionally deleted, replaced by `conversation.ts`

## LINE Limits

- Max message length: **5000 characters** — truncate summaries before calling `pushMessage()`
- Morning report summaries capped at 120 chars per item

## Before Committing

Run `npm run build` — catches TypeScript errors that `dev` mode skips.
