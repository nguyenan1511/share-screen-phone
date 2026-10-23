# Tether

Your iPhone as a second screen for your Mac. Work with the Mac's own mouse and keyboard;
look at the phone.

- **Website:** https://share-screen-phone.vercel.app — share any screen, window or tab to an
  iPhone from Chrome (rooms in Upstash Redis on Vercel).
- **Mac app:** https://share-screen-phone.vercel.app/download/mac —
  adds a real iPhone screen (a virtual monitor only the phone shows), an instant cursor,
  ⌘P / ⌘O shortcuts, and updates itself. Install guide: `/install` on the website.

## Run it on your Mac (development)
```
npm start            # local server: http://localhost:3001 (laptop), QR code for the iPhone
npm run app          # the Electron app from source
```
The iPhone joins over the same Wi-Fi (scan the QR code). Port taken? The server moves to the
next free one and prints it.

## Release a new Mac version
Full details: [RELEASING.md](RELEASING.md). In short:
1. Commit your changes.
2. `npm version patch --no-git-tag-version`, then commit `package.json` + `package-lock.json`.
3. `npm run release:mac` — builds, uploads to S3, publishes `mac/latest.json` last, then deletes
   the previous version from S3 (only the newest is kept).

Installed apps (0.1.3+) find the new version within ~4 hours, download it in the background
and install it when they aren't sharing. Needs `.env.release` (git-ignored) with the S3
upload key; see RELEASING.md.

## Layout
| Path | What |
|---|---|
| `server.js` | Local/hosted server: pages + signaling (memory, or Redis via `signal-redis.js`) |
| `public/` | Laptop page (`host.html`), iPhone page (`view.html`), drop zone, install guide |
| `native/` | macOS helper (Swift): virtual iPhone display, cursor, shortcuts, input |
| `desktop/` | Electron app (`main.js`), updater (`updater.js`), preload |
| `scripts/` | `release-mac.mjs` (S3 release), `after-pack.cjs` (ad-hoc signing) |
| `DESIGN.md` | UI design rules (Apple-based, with Tether overrides at the end) |
