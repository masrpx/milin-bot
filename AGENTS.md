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
- Errors: catch silently only in fire-and-forget paths; surface in cron/webhook via `console.error` + 500

## Do NOT

- Do NOT call `JSON.parse` on `req.body` in webhook — always `req.text()` first (signature requires raw body)
- Do NOT read/write `05 Milin/` folder except through `lib/vault.ts`
- Do NOT add new Claude Sonnet calls where Haiku suffices (scoring/extraction tasks)
- Do NOT add `use client` to API routes or lib files

## Before Committing

Run `npm run build` — catches TypeScript errors that `dev` mode skips.
