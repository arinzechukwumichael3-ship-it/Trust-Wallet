# Helpry — Trust Wallet support chat widget

A Trust Wallet–themed landing page with a live support chat widget and a separate
admin console. The widget registers a client session, lets the user chat with an
agent, and the admin replies from `/admin`. Conversations persist so they survive
page reloads and app restarts.

## Project layout

- `server.js` — Express app (the single source of truth for the API). Runs as a
  local server via `npm start`, and is re-used as-is by the Vercel serverless function.
- `api/index.js` — Vercel entry point; just exports the Express app from `server.js`.
- `lib/store.js` — persistence layer. Uses **Vercel KV** automatically when a KV
  store is linked to the project, otherwise falls back to `data/state.json` on disk.
- `admin.html` — admin console (client list + reply composer).
- `helpry.jp/cmupnn-trustwallet-*.html` — the widget / landing page.
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
   Vercel auto-detects `vercel.json` and the `api/` folder — no framework preset needed.
3. **Add durable storage** (required, because serverless filesystems are ephemeral):
   - Vercel dashboard → **Storage → Create / Link a Store → KV**.
   - Choose "Link to this project". Vercel injects `KV_REST_API_URL` and
     `KV_REST_API_TOKEN` automatically. `lib/store.js` picks them up with no code change.
   - (Alternative: Upstash Redis → Storage → Upstash. Install `@upstash/redis` and point
     `lib/store.js` at `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.)
4. Deploy. The widget at `/helpry.jp/...` and admin at `/admin` now run on Vercel
   with conversations persisted in KV.

> Without a linked KV (or other DB) store, Vercel's ephemeral filesystem means chats
> would be lost whenever a function instance recycles. Linking KV is what makes
> "connect GitHub and it just works" true.

## Notes / known limitations

- Image uploads are accepted (up to 3) but not yet stored; `image_urls` stays empty.
  On Vercel, persist images to Vercel Blob and store the returned URLs.
- `/admin` has no authentication. Add a token/env guard before exposing it publicly.
- The widget references Pusher/Laravel Echo for realtime push, but delivery currently
  relies on polling (widget every 3s, admin every 5s). Echo is wired but unused server-side.

## API summary

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/register-client` | Create a client session, returns `cache_lock` |
| POST | `/api/verify-cache-lock` | Validate a stored `cache_lock` (page reload) |
| POST | `/api/messages/fetch` | List a client's messages |
| POST | `/api/messages/send` | Client sends a message (text + up to 3 images) |
| POST | `/api/admin/reply` | Admin replies to a client by `client_id` |
| GET  | `/api/admin/clients` | Full client + message list for the admin UI |
| GET  | `/api/admin/seed-demo` | Seed a demo client |
| GET  | `/admin` | Admin console |
| GET  | `/health` | Health check |
