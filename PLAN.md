# PLAN.md — WhatsApp Dashboard MVP (build plan)

> **Status (updated):** All 3 phases are built, but only tested against a mocked Evolution API, not yet with a real number. Changes from the plan below:
> - **Auth removed** (no login, no password/JWT). Keep the backend private (localhost / SSH tunnel).
> - **Added:** voice-note sending, on-demand playback of received voice/images, a Contacts tab, browser desktop notifications (Notification API), SQLite `contacts` table.
> - Phase 2 and 3 were built together. Acceptance lists below are the test checklist.
> - Frontend state uses zustand; one WebSocket lives in the root layout.

Local web dashboard to connect several WhatsApp numbers, read chats live, send text, and get in-app notifications.
Built in **3 phases**. After each phase: run it, check the acceptance list, then **stop and wait for approval**.

---

## 0. Ground rules

- Scope is fixed to what is in the 3 phases. Anything in "Not in MVP" is not built.
- Evolution API is the only WhatsApp gateway. Only the backend talks to it; the browser never sees its API key.
- Webhook payload shapes are **not guessed**: the first real payload of each event type is saved to `docs/payloads/<EVENT>.json`, and parsers are written against those files.
- The Evolution Docker image is pinned to an exact version tag, confirmed from the official docs at build time.
- Use `localhost` everywhere (not `127.0.0.1`) so the auth cookie is shared between `:3001` and `:8000`.

### Not in MVP
Sending media / voice notes, calls, SMS, browser/OS push notifications, search, scheduling, auto-replies, multi-user.
Incoming non-text messages show a placeholder only: `[Image]`, `[Video]`, `[Voice message]`, `[Document]`, `[Sticker]`, `[Location]`, `[Contact]`, `[Unsupported message]`.

---

## 1. Stack and ports

| Part | Choice | Port |
|---|---|---|
| WhatsApp gateway | Evolution API v2 (Docker) + Postgres 16 + Redis 7 | 8080 (bound to 127.0.0.1) |
| Backend | FastAPI, Python 3.11+, SQLAlchemy 2, SQLite, httpx, Pydantic v2, pydantic-settings, PyJWT | 8000 (127.0.0.1) |
| Realtime | FastAPI WebSocket `/ws` | 8000 |
| Frontend | Next.js (App Router) + TypeScript + Tailwind, Zustand for client state | 3001 |
| Auth | One password from `.env` → JWT in httpOnly, SameSite=Lax cookie | — |

Tables are created on startup with `create_all`. No Alembic.

```
Browser (Next.js :3001) ──REST + WS (cookie)──▶ FastAPI (:8000) ──▶ SQLite (data/app.db)
                                                  │  ▲
                                         REST+apikey │  │ webhook ?secret=
                                                  ▼  │
                                   Evolution API (:8080) ── Postgres + Redis
                                                  ▼
                                   WhatsApp (1 number = 1 instance = 1 account row)
```

---

## 2. Repo layout (final)

```
monkey-man-whatsapp-dashboard/
├─ PLAN.md  README.md  .env.example  .gitignore  docker-compose.yml
├─ docs/payloads/                 # real webhook samples (captured, not invented)
├─ backend/
│  ├─ requirements.txt
│  └─ app/
│     ├─ main.py                  # app, CORS, routers, create_all, /health, /ws
│     ├─ config.py  db.py  models.py  schemas.py
│     ├─ auth.py                  # JWT create/verify, require_user dependency, login rate limit
│     ├─ ws.py                    # ConnectionManager.broadcast(event, data)
│     ├─ evolution.py             # async httpx wrapper (all Evolution calls live here)
│     ├─ normalize.py             # webhook payload → plain dicts (Phase 2)
│     └─ routers/ auth.py accounts.py chats.py webhook.py
└─ frontend/
   ├─ app/ login/page.tsx  accounts/page.tsx  page.tsx (main 3-pane, Phase 2)
   ├─ components/ ...
   ├─ lib/ api.ts  store.ts  useSocket.ts
   └─ .env.local (NEXT_PUBLIC_API_URL)
```

## 3. `.env.example`

```
# Evolution
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=change-me-long-random
# Backend
APP_PASSWORD=change-me
JWT_SECRET=change-me-long-random
WEBHOOK_SECRET=change-me-random
WEBHOOK_BASE_URL=http://host.docker.internal:8000
DATABASE_URL=sqlite:///./data/app.db
FRONTEND_ORIGIN=http://localhost:3001
# Frontend
NEXT_PUBLIC_API_URL=http://localhost:8000
# Postgres for Evolution
POSTGRES_USER=evolution
POSTGRES_PASSWORD=change-me
POSTGRES_DB=evolution
```

## 4. Data model (SQLite)

| Table | Columns | Notes |
|---|---|---|
| `accounts` | id, label, instance_name (unique), phone_number, status, created_at | status: `connecting` \| `connected` \| `disconnected`. instance_name = `acc_<8 random hex>` (label can be anything, instance name stays safe) |
| `chats` | id, account_id, jid, name, is_group, last_message_at, last_message_preview, unread_count | unique (account_id, jid) |
| `messages` | id, account_id, chat_id, wa_message_id, from_me, sender_name, type, text, status, timestamp | unique (account_id, wa_message_id). type: `text` \| `other`. status: `pending` \| `sent` \| `delivered` \| `read` \| `failed` |

Deleting an account deletes its chats and messages (cascade).

## 5. API surface (everything except login, health and webhook requires the cookie)

```
POST /auth/login {password}      POST /auth/logout      GET /auth/me
GET  /health

GET    /accounts                         P1
POST   /accounts {label}                 P1  create instance (with webhook config) → row status=connecting
GET    /accounts/{id}/qr                 P1  {status, qr_base64|null}
POST   /accounts/{id}/disconnect         P1  logout instance, keep row
DELETE /accounts/{id}                    P1  delete instance + row
POST   /accounts/{id}/sync               P2  import chats + recent messages

GET  /accounts/{id}/chats                                   P2
GET  /accounts/{id}/chats/{chat_id}/messages?before=&limit=50  P2
POST /accounts/{id}/chats/{chat_id}/read                    P2
POST /accounts/{id}/send {chat_id | to, text, client_id}    P3
POST /accounts/{id}/messages/{message_id}/retry             P3

POST /webhook/evolution?secret=...       P1 (connection/QR), P2 (messages)
WS   /ws                                 P1
```

WebSocket events (server → browser), shape `{type, account_id, data}`:
`account.status` (P1, includes fresh QR), `message.new` (P2), `chat.updated` (P2), `message.status` (P3).

---

## PHASE 1 — Infra + auth + connect multiple numbers

**Goal:** log in, add numbers by QR, see status change live, disconnect/remove.

### Steps
1. **Verify Evolution facts** in https://doc.evolution-api.com: current image name + latest stable v2 tag, required env vars (API key, Postgres, Redis), exact paths/payloads for create / connect / connectionState / logout / delete / webhook set. Record findings at the top of `backend/app/evolution.py`.
2. **Infra:** `docker-compose.yml` with `evolution-api` (pinned tag), `postgres:16-alpine`, `redis:7-alpine`, named volumes, `extra_hosts: host.docker.internal:host-gateway`, ports bound to `127.0.0.1`. `.env.example`, `.gitignore` (`.env`, `data/`, `node_modules`, `.next`, `__pycache__`, `.venv`).
3. **Backend skeleton:** config, db (creates `data/` folder), models, `create_all`, CORS (exact origin + credentials), `/health`.
4. **Auth:** `/auth/login` (constant-time compare, 5 attempts/min per IP, in memory), JWT cookie (httpOnly, SameSite=Lax, 7 days), `/auth/logout`, `/auth/me`, `require_user` dependency; WS checks the same cookie.
5. **`evolution.py`:** one shared `httpx.AsyncClient`, `apikey` header, timeout 15 s, clean error type; API key never logged.
6. **Accounts router:** create (instance + webhook events `CONNECTION_UPDATE`, `QRCODE_UPDATED`, `MESSAGES_UPSERT`, `MESSAGES_UPDATE` set right away), qr, disconnect, delete, list (list also refreshes status from `connectionState` so the DB never goes stale).
7. **Webhook route:** check secret → save first payload per event type to `docs/payloads/` → handle `CONNECTION_UPDATE` (status + phone number) and `QRCODE_UPDATED` (new QR) → broadcast `account.status` → 200. Other events: ignored for now (but captured).
8. **WS manager:** keep sockets, `broadcast()`, drop dead sockets.
9. **Frontend:** Next.js app on 3001, `lib/api.ts` (fetch with `credentials: 'include'`), `useSocket` (auto-reconnect with backoff, reused in P2/P3), `/login`, `/accounts`:
   - list with status dot (green/amber/grey), label, phone number
   - **+ Connect a number** → label input → QR modal; QR updates from WS, with a 20 s polling fallback; modal closes itself on `connected`
   - Disconnect (confirm), Remove (confirm), Reconnect (re-opens QR for a disconnected account)
   - yellow risk banner: unofficial API, ban risk, use a spare number, no bulk sending
   - unauthenticated → redirect to `/login`

### Acceptance (Phase 1)
- [ ] `docker compose up -d` brings up Evolution, Postgres, Redis; `GET :8080` answers.
- [ ] Backend starts with one command, frontend with one command.
- [ ] Wrong password is rejected; 6th quick attempt is rate-limited.
- [ ] Add "Personal" → QR shows → scan → status turns **connected** with no page refresh.
- [ ] Add a second number the same way → both connected.
- [ ] Disconnect works (status → disconnected, phone logged out). Remove works (gone from list and from Evolution).
- [ ] `docs/payloads/` contains real `CONNECTION_UPDATE` and `QRCODE_UPDATED` samples (and any message samples that arrived).

**→ Stop and wait for approval.**

---

## PHASE 2 — Chats and messages, live

**Goal:** WhatsApp-Web-style reading view, live updates, number switching.

### Steps
1. **Capture real message payloads** (text, image, voice, group message, my own message from the phone, a status update) into `docs/payloads/`. Write `normalize.py` against them:
   - jid, is_group (`@g.us`), from_me, wa_message_id, sender_name (pushName), timestamp (seconds → UTC datetime)
   - text from `conversation` / `extendedTextMessage.text`; everything else → `type=other` + placeholder
   - skip `status@broadcast` and protocol/reaction messages
2. **Webhook `MESSAGES_UPSERT`:** upsert chat → insert message (ignore duplicate `wa_message_id`) → update preview/last time → `unread_count += 1` only when `from_me = false` → broadcast `message.new` + `chat.updated`.
3. **Webhook `MESSAGES_UPDATE`:** map Evolution ack values to `sent|delivered|read` (from captured payload), never downgrade a status → broadcast `message.status`.
4. **Sync endpoint:** `findChats` → upsert chats; `findMessages` for the 30 most recent chats × last 30 messages. Runs automatically once when an account becomes connected, plus a "Sync" button. Idempotent, safe to run again.
5. **Read endpoints:** chats sorted by `last_message_at desc`; messages paginated by `before` (timestamp cursor) newest-first from API, rendered oldest-first.
6. **Mark as read:** sets `unread_count = 0` locally, broadcasts `chat.updated` (no read receipt sent to WhatsApp in MVP).
7. **Frontend `/` (3 panes):**
   - Top bar: number switcher chips (status dot + unread total per number), link to manage numbers, logout.
   - Left: chat list (avatar initial, name, preview, time, unread badge), sorted live.
   - Center: bubbles (mine right / theirs left), time, sender name in groups, placeholders in italic, auto-scroll to bottom on open and on new message (only if already near bottom), load older on scroll-up without jumping.
   - Composer visible but disabled ("Sending comes in Phase 3").
   - Selected account + chat kept in the URL (`/?account=1&chat=42`) so refresh keeps the place.
   - Mobile (< 768 px): list → conversation → back button.
8. `useSocket` events update the Zustand store; on WS reconnect, refetch chats for the current account to catch missed events.

### Acceptance (Phase 2)
- [ ] After connecting, existing chats from the phone appear (sync).
- [ ] A message sent from another phone appears in the right chat within ~2 s, no refresh.
- [ ] Switching numbers shows only that number's chats.
- [ ] Opening a chat clears its unread count (chat list + switcher).
- [ ] Group messages show the sender's name; images/voice show placeholders.
- [ ] Page refresh keeps all history (SQLite).
- [ ] Mobile width works as single-pane navigation.

**→ Stop and wait for approval.**

---

## PHASE 3 — Send text + in-app notifications + README

**Goal:** reply from the dashboard and never miss a message while the tab is open.

### Steps
1. **Send endpoint:** body `{chat_id | to, text, client_id}`. Insert `pending` row → per-account throttle (asyncio lock, ≥ 1 s between sends) → Evolution `sendText` → save returned `wa_message_id`, status `sent`, or `failed` → broadcast `message.new` / `message.status` with `client_id` so the browser swaps its optimistic bubble. The later webhook echo of the same message is deduplicated by `wa_message_id`.
2. **Retry endpoint** for `failed` messages (reuses the same row).
3. **New chat:** dialog with phone number (country code, digits only, validated) + first message → backend builds the jid, creates chat, sends.
4. **Composer:** Enter = send, Shift+Enter = newline, auto-growing textarea, disabled while account not connected. Ticks: 🕓 pending, ✓ sent, ✓✓ delivered, blue ✓✓ read, red ! failed + **Retry**.
5. **Notifications** (from `message.new` with `from_me = false`):
   - Toast top-right: number label, sender, preview. Click → switch account + open chat. Auto-dismiss 5 s, max 3 stacked.
   - No toast when that chat is open **and** the tab is visible/focused.
   - Live unread badges on switcher and chat list (already wired in P2).
   - Tab title `(N) WhatsApp Dashboard`, back to plain title at 0.
   - Soft sound (small bundled file, Web Audio fallback), mute toggle in top bar saved in `localStorage`.
6. **Error toasts:** send failed, WebSocket disconnected / reconnected, account disconnected.
7. **README:** prerequisites, setup on Windows (PowerShell) and Mac/Linux, `.env` setup, start commands, first-run flow, phone-on-WiFi option (`--host 0.0.0.0` + warning), known limits, ban risk, troubleshooting (webhook not arriving, QR expired, port in use).

### Acceptance (Phase 3)
- [ ] Text sent from either number arrives on a real phone; ticks move pending → sent → delivered → read.
- [ ] Turning the backend's network off (or a bad number) shows a failed bubble; Retry works.
- [ ] New chat by phone number works.
- [ ] With number A open, a message to number B shows a toast and bumps B's badge; clicking it opens that chat.
- [ ] No toast for the chat currently being read.
- [ ] Tab title count and mute toggle work.
- [ ] Fresh clone + README only = working app.

**→ MVP complete. Stop.**

---

## 6. Security checklist (applies across phases)
- Backend and Evolution bound to localhost by default; Evolution port never exposed publicly.
- Evolution API key only in backend env; never returned or logged.
- Webhook requires `WEBHOOK_SECRET` (compared in constant time).
- Cookie httpOnly + SameSite=Lax; CORS allows only `FRONTEND_ORIGIN` with credentials.
- Login rate-limited. `.env` and `data/` git-ignored.

## 7. Known risks to watch
| Risk | Handling |
|---|---|
| Evolution payload/endpoint differences between versions | pinned tag + captured payloads + all calls isolated in `evolution.py` / `normalize.py` |
| WhatsApp `@lid` ids instead of phone jids for some contacts | store whatever jid arrives; use `remoteJidAlt`/phone field if present in captured payload |
| Webhook can't reach backend from Docker | `host.docker.internal` + `extra_hosts`; README troubleshooting step |
| Number ban | banner, throttle, no bulk features |
| Missed WS events while offline | refetch on reconnect; SQLite is the source of truth |

## 8. After MVP (not now)
1. Send/receive media  2. Voice notes  3. Browser notifications → PWA push  4. Search, contacts, quick replies  5. Call log, SMS provider
