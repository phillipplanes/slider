# Slide Display Site

A single-file, zero-dependency Node.js site: an admin manages named slide sets
and uploads slides, viewers sign in and watch the active set cycle
automatically, and changes go live instantly. Watch time is tracked per slide
(aggregate) and per signed-in viewer (per set and per slide).

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (built-in `fetch` required for Microsoft SSO)

## Quick start

```bash
node server.js
```

- Viewer: http://localhost:3000/  (cycles the active set)
- Admin:  http://localhost:3000/admin (default key: `admin123` — change it!)

On first run a `slide-data/` folder is created next to `server.js` holding the
sets, uploaded slides, stats, and an `error.log`. If you upgrade from an older
version, an existing flat slide list is automatically migrated into a set
named "Default Set". Everything survives restarts.

## Configuration (environment variables)

| Variable           | Default     | Purpose                                        |
|--------------------|-------------|-----------------------------------------------|
| `PORT`             | `3000`      | Listen port                                   |
| `ADMIN_KEY`        | `admin123`  | Fallback admin password (set it!)             |
| `USER_KEY`         | `user123`   | Temporary shared viewer key (name + key login)|
| `DEFAULT_SECONDS`  | `20`        | Time per slide at 1× speed                   |
| `MS_TENANT_ID`     | –           | Microsoft Entra tenant ID (enables SSO)       |
| `MS_CLIENT_ID`     | –           | Microsoft Entra app client ID (enables SSO)   |
| `ADMIN_EMAILS`     | –           | Comma-separated admin emails; empty = any signed-in org user |

Example:

```bash
PORT=8080 ADMIN_KEY=secret USER_KEY=class DEFAULT_SECONDS=20 \
MS_TENANT_ID=xxxx MS_CLIENT_ID=yyyy ADMIN_EMAILS=you@yourorg.com \
node server.js
```

## Slide sets

- Slides belong to named sets (e.g. "Week 1 – Intro"). On the admin page you
  can create, rename, delete, and pick the **active** set.
- Every viewer automatically follows the active set; switching sets updates
  all open viewers live (SSE push, with a 60s re-check fallback).
- Uploads, reordering, and deletes apply to the set selected in the admin's
  set dropdown.

## Viewer controls

- Auto-cycle with a progress bar; hover (or move the mouse) to reveal controls.
- **Speed slider**: 0.5× (slower) to 2× (faster); 1× = `DEFAULT_SECONDS`
  (20s by default). The label shows the effective seconds per slide.
- Back / forward / pause; keyboard: arrows navigate, space pauses, `f` fullscreen.

## Viewer sign-in

Viewers can sign in so watch time is tracked per person:

- **Microsoft SSO** — a "Sign in with Microsoft" button appears on the viewer
  once `MS_TENANT_ID` / `MS_CLIENT_ID` are set. Their org email becomes the
  identity in the stats.
- **Temporary key login** — until SSO is set up, viewers enter their name plus
  the shared `USER_KEY` (a small form in the top-right corner). Once SSO works,
  set `USER_KEY=""` to hide it — or keep both.

Viewers who don't sign in still count toward per-slide aggregate totals, but
not toward individual stats. The same Microsoft login grants admin access if
the user's email is in `ADMIN_EMAILS`.

## Microsoft SSO setup

1. In the [Azure Portal](https://portal.azure.com), register an app under
   **Microsoft Entra ID → App registrations**.
2. Under **Authentication**, add a redirect URI:
   `http://localhost:3000/api/ms/callback` (adjust host/port to your deployment).
3. Copy the **Tenant ID** and **Client ID** into `MS_TENANT_ID` / `MS_CLIENT_ID`.
4. Set `ADMIN_EMAILS` to the people who should have admin access.
   If empty, any user who signs in with your org account gets admin.
   Key-based logins always remain available as fallbacks.

## Stats (admin page)

Pick a set in the dropdown; the tables show stats for that set:

- **Aggregate stats** — per slide: views, total watch time, average per view,
  plus the set's total watch time.
- **Viewer stats** — per signed-in viewer: all-time total, total for this set,
  and a per-slide breakdown within this set.

Watch time is counted only while a slide is visible, unpaused, and the tab is
in the foreground. Viewers batch reports every 15s and flush on tab close.

## Stability

- Global handlers catch request, stream, and client errors and log them to
  `slide-data/error.log` instead of crashing the server. If you ever see a
  crash, that log file is the place to look.
- Deleting a slide while a viewer is downloading it no longer kills the process.

## Run in the background

macOS/Linux:

```bash
nohup node server.js > slides.log 2>&1 &
```

With systemd (`/etc/systemd/system/slides.service`):

```ini
[Unit]
Description=Slide Display Site
After=network.target

[Service]
WorkingDirectory=/opt/slides
ExecStart=/usr/bin/node server.js
Environment=ADMIN_KEY=secret
Environment=USER_KEY=class
Environment=PORT=3000
Restart=always

[Install]
WantedBy=multi-user.target
```

Then: `sudo systemctl enable --now slides` (with `Restart=always`, systemd
will also bring the site back after a machine reboot).

## Notes

- Serve over HTTPS in production (e.g., behind Caddy or nginx) — cookies are
  not `Secure`-flagged by default.
- Microsoft SSO uses OAuth2 + PKCE; the id token claims are decoded without
  signature verification (the token comes directly from Microsoft's token
  endpoint over TLS). Add JWKS validation if you need strict guarantees.
- Max upload size is 200 MB per request.
