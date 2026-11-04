<p align="center">
  <img src="frontend/public/houseflippah-logo.svg" alt="houseflippah logo" width="420" />
</p>

<p align="center">
  <strong>A fresh take on a stale board game.</strong><br>
  Real-time online multiplayer game for 2 to 4 players with seamless guest access, transactional room joining, and real-time state synchronization.
</p>

---

## Architecture Overview

* **Frontend**: Vanilla JavaScript (ES modules) bundled with [Vite](https://vitejs.dev/) — zero heavy runtime frameworks, fast local HMR, and builds static assets (`dist/`) ready for deployment to any CDN (Cloudflare Pages, Vercel, Netlify).
* **Backend**: [Supabase](https://supabase.com/) running PostgreSQL, GoTrue Auth (Anonymous Sign-Ins), Realtime engine, and Row-Level Security (RLS).
* **Container Runtime**: [Podman](https://podman.io/) (aliased to Docker via Homebrew).
* **Concurrency & Integrity**: Atomic Postgres stored procedures (`create_room`, `join_room`, `leave_room`) utilizing row-level locking (`SELECT ... FOR UPDATE`) to guarantee that the strict 4-player room cap can never be exceeded by simultaneous join attempts.

---

## Features

* **Instant Guest Onboarding**: Players do not need an email or password. Supabase Anonymous Auth provides a real session token and cryptographic UID saved in browser storage.
* **UUID Invite Links**: The host starts a game and receives a shareable link (e.g. `http://localhost:5173/?room=<UUID>`).
* **Host vs. Guest Lobby Experience**:
  * **Host**: Manages the lobby, copies invite links, sees player count, and controls "Start Game" (enabled once 2–4 players join) and "End Game".
  * **Guests**: See their assigned seats and a live connection indicator while waiting for the host to start.
* **Seat Recycling & Abandonment**: When a player leaves or the host ends a game, seats are immediately freed and room status transitions smoothly in real time.
* **Abuse Prevention**:
  * Strict database-level check constraints and transaction locks.
  * Rate-limiting on room creation per anonymous UID.
  * Input validation and sanitization for usernames (1–20 characters).

---

## Getting Started Locally

### Prerequisites

* **Node.js** (v20+ recommended, v26 installed) & **npm**
* **Podman** (with machine initialized and started)
* **Supabase CLI** (`brew install supabase/tap/supabase`)

### 1. Start the Backend (Supabase)

```bash
# 1. Ensure the Podman VM is running
podman machine start

# 2. Start the local Supabase stack
supabase start
```

Once started, the local backend endpoints will be available:
* **Supabase Studio (Dashboard)**: [http://127.0.0.1:54323](http://127.0.0.1:54323)
* **API / Kong Gateway**: [http://127.0.0.1:54321](http://127.0.0.1:54321)
* **Database**: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

### 2. Start the Frontend Dev Server

```bash
cd frontend
npm install
npm run dev
```

Visit **[http://localhost:5173](http://localhost:5173)** in your browser.

---

## Automated Joining Workflow Tests

The project includes an end-to-end integration test that simulates 5 concurrent anonymous players joining, capacity rejection, seat recycling, and name sanitization:

```bash
cd frontend
npm test
```

Test coverage includes:
1. Creating 5 isolated anonymous player sessions.
2. Room creation by Host (assigned to Seat 1).
3. Players 2, 3, and 4 joining (Seats 2, 3, 4).
4. Player 5 joining a full 4/4 room $\rightarrow$ **strictly rejected with capacity error**.
5. Player 3 leaving the room $\rightarrow$ Seat 3 freed.
6. Player 5 re-attempting join $\rightarrow$ **successfully seated in the freed slot**.
7. Input sanitization validation on invalid display names.

---

## Production Deployment

* **Backend**: Link to your Supabase Cloud project (`supabase link --project-ref <id>`) and push migrations (`supabase db push`).
* **Frontend**: Build production assets with `npm run build` inside `frontend/` and point your CDN provider (Cloudflare Pages, Netlify, Vercel) to the `dist/` directory with environment variables:
  * `VITE_SUPABASE_URL`
  * `VITE_SUPABASE_ANON_KEY`
