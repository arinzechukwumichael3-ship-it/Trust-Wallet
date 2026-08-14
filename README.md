# Helpry — Trust Wallet support chat widget

A Trust Wallet–themed landing page with a live support chat widget and a separate
admin console. The widget registers a client session, lets the user chat with an
agent, and the admin replies from `/admin`. Conversations persist so they survive
page reloads and app restarts.

## Project layout

- `server.js` — Express app (the single source of truth for the API). Runs as a
  local server via `npm start`, and is re-used as-is by the Vercel serverless function.
- `api/index.js` — Vercel entry point; just exports the Express app from `server.js`.
- `lib/store.js` — persistence layer. Uses **Upstash Redis** (or legacy Vercel KV)
  automatically when a store is linked to the project, otherwise falls back to
  `data/state.json` on disk.
- `public/admin.html` — admin console (client list + reply composer).
- `public/helpry.jp/cmupnn-trustwallet-*.html` — the widget / landing page.
- `server.py` — standalone Python port of the API (kept for reference; not used in prod).

## Run locally

```bash
npm install
npm start            # http://127.0.0.1:5500
```

- Widget: http://127.0.0.1:5500/helpry.jp/cmupnn-trustwallet-xostfj-helpry-eohlok-trustwallet-gkqtyx.html
- Admin:  http://127.0.0.1:5500/admin
- Health: http://127.0.0.1:5500/health

Local state is stored in `data/state.json` (gitignored).

## Deploy to Vercel (connect via GitHub)

1. Push this repo to GitHub.
2. In the Vercel dashboard: **Add New → Project → Import Git Repository** and select this repo.
   Vercel auto-detects `vercel.json`, the `public/` static folder, and the `api/` serverless
   function — no framework preset needed.
3. **Add durable storage** (required, because serverless filesystems are ephemeral):
   - Vercel dashboard → **Storage → Upstash Redis → Create** (Vercel's current recommended store).
   - Link it to the project. Vercel injects `UPSTASH_REDIS_REST_URL` and
     `UPSTASH_REDIS_REST_TOKEN` automatically. `lib/store.js` picks them up with no code change.
   - (Legacy: a Vercel KV store also works — it injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`,
     which the store still supports as a fallback.)
4. Deploy. The widget at `/helpry.jp/...` and admin at `/admin` now run on Vercel
   with conversations persisted in Upstash Redis.

> Without a linked store (Upstash or KV), Vercel's ephemeral filesystem means chats would be
> lost whenever a function instance recycles. Linking a store is what makes "connect GitHub and
> it just works" true.

## Notes / known limitations

- **Admin auth:** `/admin` is protected by a shared password (`ADMIN_PASSWORD` env var, default `helpry-admin` — change it). The password is never exposed to the client; every `/api/admin/*` route requires the session cookie.
- **Image/file uploads:** accepted from both the widget and the admin (up to 3, 8 MB each). When `BLOB_READ_WRITE_TOKEN` is set, uploads go to Vercel Blob (durable public URLs); otherwise they are stored inline as data URLs so they always render on Vercel's read-only filesystem.
- **Realtime:** the admin polls every 5s and the widget every 3s. There is no websocket push server; Laravel Echo is wired but unused server-side.
- **Durability:** every client that registers (Start Chat) is saved permanently in the store. They are only removed when an admin deletes them from the admin console. For permanence on Vercel, link Upstash Redis (see deploy steps) — without it, Vercel's ephemeral `/tmp` can lose data on cold starts.

## Email notifications (client ↔ support)

The widget requires the customer to **connect their email before chatting** (Start Chat screen). Once connected, every message triggers a professional, branded email through Resend using the shared business inbox `wallet@yieldempire.org`:

- **Client sends a message** → the transcript is emailed to the support inbox **and every address in `ADMIN_NOTIFY_EMAILS`** (the people who run support). The email's `Reply-To` is set to the customer's address, so support can reply straight from their inbox and it threads back to the person.
- **Support replies in the admin console** → the customer is emailed that reply from `wallet@yieldempire.org` (sent to the email the client connected on the widget).

Email is best-effort: a delivery failure is logged and never blocks the in-app chat.

### Required env vars (Vercel project → Settings → Environment Variables)

| Var | Value |
|-----|-------|
| `RESEND_API_KEY` | API key from https://resend.com (starts with `re_`) |
| `EMAIL_FROM` | `Support <wallet@yieldempire.org>` |
| `SUPPORT_EMAIL` | `wallet@yieldempire.org` |
| `ADMIN_NOTIFY_EMAILS` | Comma-separated extra inboxes that also receive each client→support message (e.g. `a@gmail.com,b@gmail.com`) |

> **Resend deliverability:** the `yieldempire.org` (or `helpry.jp`) domain must be **verified in Resend** (add the DNS records Resend shows you) before real emails send. While unverified, Resend stays in test mode and only allows its own test address — the code still runs, the chat still works, and the failed send is logged so nothing is lost. `APP_URL` (your production domain, e.g. `https://helpry.jp`) makes the "Open the chat" button in emails point to the live site.

## Wrapping the admin as a mobile app (Median.co / APK)

The admin console is a normal web page, so Median.co can wrap `/admin` into an Android APK. To get notified of new client messages on your phone:

1. Build the APK at median.co pointing at `https://<your-vercel-domain>/admin` and install it.
2. When the app is open, the admin page shows an in-app toast + plays a sound + fires a system notification whenever a client sends a new message (the 5s poll detects it). Tap the notification to jump into that conversation.
3. For notifications while the app is **backgrounded/closed**, use Median's **Native Push** feature: enable push in the Median project, and when a notification arrives open the app to `/admin` to see the message. (True server→device push would require a push provider like Firebase; the in-app alert covers the "app open" case, which is what matters for live support.)

Set `ADMIN_PASSWORD` in Vercel env vars so the wrapped app prompts for the password on launch.

## API summary

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/register-client` | Create a client session (requires `email`), returns `cache_lock` |
| POST | `/api/verify-cache-lock` | Validate a stored `cache_lock` (page reload) |
| POST | `/api/messages/fetch` | List a client's messages |
| POST | `/api/messages/send` | Client sends a message (text + up to 3 images); emails support |
| POST | `/api/admin/reply` | Admin replies to a client by `client_id`; emails the client |
| GET  | `/api/admin/clients` | Full client + message list (incl. connected `email`) for the admin UI |
| GET  | `/api/admin/storage-status` | Whether data is durable (Redis) or temporary |
| DELETE | `/api/admin/clients/:id` | Permanently delete a client + their messages |
| POST | `/api/admin/login` | Admin password login (sets session cookie) |
| POST | `/api/admin/logout` | Clear the session cookie |
| GET  | `/api/admin/me` | Returns whether the current session is authed |
| GET  | `/api/admin/seed-demo` | Seed a demo client |
| GET  | `/admin` | Admin console |
| GET  | `/health` | Health check |

> The sending domain for production email is `yieldempire.org` — it must be verified in Resend (DNS records) for delivery to leave test mode.
