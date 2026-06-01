<div align="center">

<img src="public/favicon.svg" width="80" height="80" alt="NexusMail">

# NexusMail

**Modern webmail client for self-hosted email**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

[Features](#features) · [Screenshots](#screenshots) · [Quick Start](#quick-start) · [Configuration](#configuration) · [Architecture](#architecture) · [API Reference](#api-reference)

</div>

---

NexusMail is a lightweight, self-hosted webmail client with a dark UI, real-time updates, and a single-page app experience. It connects directly to your IMAP/SMTP server — no database required, no third-party dependencies on your mail data.

Built with vanilla JavaScript, Express, and [ImapFlow](https://imapflow.com/). Deploy in under 5 minutes on any VPS.

## Features

### 📬 Core Email
- **IMAP folders** — automatic discovery, unread counts, hierarchy support
- **Message list** — sender avatars, unread highlighting, new mail glow effect
- **HTML & plain text** — sandboxed iframe rendering, one-click toggle
- **Compose** — rich text editor (bold, italic, lists, links, alignment) with plain text mode
- **Reply / Reply All / Forward** — quoted text, pre-filled recipients, CC support
- **Attachments** — upload, download, file type icons, 25 MB limit
- **Search** — server-side IMAP search (from, to, subject, body)

### ⚡ Real-Time
- **WebSocket updates** — new mail, flag changes, folder counts — no page refresh
- **IMAP IDLE** — instant notifications when mail arrives, 15s polling fallback
- **Desktop notifications** — browser Notification API with sender & preview
- **Tab title badge** — `(3) NexusMail` unread count in browser tab

### 📁 Organization
- **Thread / conversation view** — group replies by References header, toggle flat vs threaded
- **Star & favorites** — quick flag, dedicated Favorites folder
- **Drag & drop** — move messages between folders
- **Right-click menus** — reply, reply all, forward, archive, move, favorite, mark read/unread, delete
- **Email routing rules** — auto-move, auto-delete, auto-mark-read on new mail
- **Keyboard shortcuts** — `J/K` navigate, `R` reply, `F` forward, `E` archive, `S` star, `C` compose, `?` help

### 📝 Compose & Drafts
- **Rich text editor** — formatting toolbar with bold, italic, underline, strikethrough, lists, links, alignment
- **Plain text mode** — toggle between rich and plain text composing
- **Drafts** — auto-save every 30 seconds, save on close, resume editing
- **Contact autocomplete** — indexes addresses from seen mail, fuzzy search on name/email

### 🔒 Security
- **IMAP-backed auth** — login validates against your mail server, no separate user database
- **Session cookies** — HttpOnly, SameSite=Strict, optional Secure flag
- **Rate limiting** — 8 login attempts per minute per IP
- **HTML sanitization** — script tags and inline event handlers stripped from email HTML
- **Sandboxed iframe** — email content rendered in isolated frame

### 🎨 Interface
- **Dark theme** — warm dark palette with accent highlights
- **Three-panel layout** — folders, message list, reading pane
- **Sender avatars** — colorful initials with deterministic hue
- **Smooth animations** — compose, overlays, toasts, hover effects
- **Responsive feedback** — toast notifications, loading spinners, optimistic UI updates

## Screenshots

> *Coming soon — the app is under active development.*

## Quick Start

### Prerequisites

- Node.js 18+
- An IMAP/SMTP server (e.g. Postfix + Dovecot, Mail-in-a-Box, Maddy)
- A domain with MX records pointing to your mail server

### Install

```bash
# Clone the repository
git clone https://github.com/brycebremer/NexusMail.cc.git
cd NexusMail.cc

# Install dependencies
npm install
```

### Configure

Edit `server.js` and update the IMAP/SMTP host settings to match your mail server:

```js
// IMAP connection (login endpoint)
host: 'mail.yourdomain.com', port: 993, secure: true,

// SMTP connection (send endpoint)  
host: 'mail.yourdomain.com', port: 587, secure: false,
```

> **Note:** The `getMailUser` function appends `@yourdomain.com` to the username. Update it to match your domain:
> ```js
> function getMailUser(username) {
>   return username.toLowerCase() + '@yourdomain.com';
> }
> ```

### Run

```bash
# Development
node server.js

# Production (systemd)
sudo cp mailpanel.service /etc/systemd/system/
sudo systemctl enable --now mailpanel
```

The app runs on port 3456 by default. Set the `PORT` environment variable to change it.

### Production Deployment

For production, run behind a reverse proxy with HTTPS:

```nginx
server {
    listen 443 ssl http2;
    server_name mail.yourdomain.com;

    ssl_certificate     /etc/ssl/certs/yourdomain.pem;
    ssl_certificate_key /etc/ssl/private/yourdomain.key;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `PORT` | `3456` | HTTP listen port |
| `SESSION_MAX_AGE` | `86400000` | Session lifetime with Remember Me (24h) |
| `SESSION_SHORT_AGE` | `1800000` | Session lifetime without Remember Me (30min) |
| `LOGIN_MAX` | `8` | Max login attempts per minute per IP |
| `multer fileSize` | `25 MB` | Max attachment upload size |
| `express.json limit` | `10 MB` | Max request body size |

## Architecture

```
NexusMail.cc/
├── server.js          # Express API server, IMAP/SMTP relay, WebSocket hub
├── rules-engine.js    # Email routing rules processor
├── rules.json         # Saved routing rules (auto-created)
├── public/
│   ├── index.html     # SPA shell, CSS, layout structure
│   ├── app.js         # Client-side application logic
│   └── favicon.svg    # Brand icon
└── package.json
```

### How It Works

```
┌─────────────┐     WebSocket      ┌──────────────┐     IMAP/SMTP     ┌─────────────┐
│   Browser   │ ◄──────────────► │  Express API  │ ◄──────────────► │  Mail Server │
│  (SPA)      │    real-time      │  (server.js)  │    ImapFlow +     │  (Dovecot +  │
│             │    updates         │               │    Nodemailer     │   Postfix)   │
└─────────────┘                    └──────────────┘                    └─────────────┘
```

1. **Login** — credentials validated by attempting an IMAP connection
2. **IMAP relay** — all folder/message operations proxied through the server
3. **SMTP relay** — compose sends through Nodemailer transport
4. **WebSocket** — server pushes new mail events, flag changes, and status updates
5. **Rules engine** — incoming mail matched against user-defined rules, actions applied in real-time

### Design Decisions

- **No database** — all state lives in IMAP and in-memory sessions
- **Single IMAP connection** — one active session at a time (multi-user would require per-session connections)
- **Vanilla JS** — zero frontend build step, no framework, no bundler
- **Express 5** — async route handlers, modern API surface

## API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/login` | Authenticate via IMAP, set session cookie |
| `POST` | `/api/logout` | Destroy session, disconnect IMAP |
| `GET` | `/api/check` | Check authentication status |

### Folders

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/folders` | List all folders with unread/total counts |
| `POST` | `/api/folders` | Create a new folder |
| `PUT` | `/api/folders` | Rename a folder |
| `DELETE` | `/api/folders` | Delete a folder |

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/messages` | List messages in a folder (paginated) |
| `GET` | `/api/message` | Get full message (body, attachments, headers) |
| `GET` | `/api/peek` | Get message preview (lightweight, for notifications) |
| `POST` | `/api/markread` | Mark messages as read |
| `POST` | `/api/markunread` | Mark messages as unread |
| `POST` | `/api/star` | Toggle star/flag on a message |
| `POST` | `/api/delete` | Delete messages (moves to Trash, or permanent if in Trash) |
| `POST` | `/api/move` | Move messages to another folder |
| `GET` | `/api/search` | Search messages (IMAP search) |
| `GET` | `/api/threads` | List threaded conversations in a folder |

### Compose & Send

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/send` | Send an email (with optional attachments) |
| `POST` | `/api/drafts/save` | Save a draft to IMAP Drafts folder |
| `GET` | `/api/attachment` | Download an attachment |

### Contacts & Rules

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/contacts` | Search autocomplete contacts |
| `GET` | `/api/rules` | List email routing rules |
| `POST` | `/api/rules` | Create a rule |
| `PUT` | `/api/rules/:id` | Update a rule |
| `DELETE` | `/api/rules/:id` | Delete a rule |
| `POST` | `/api/rules/apply` | Manually run rules on a folder |

### Housekeeping

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/emptytrash` | Permanently delete all messages in Trash |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `J` | Next message |
| `K` | Previous message |
| `R` | Reply |
| `F` | Forward |
| `E` | Archive |
| `S` | Star / favorite |
| `C` | Compose new message |
| `Delete` | Delete selected message(s) |
| `?` | Show shortcuts help |

## Roadmap

- [ ] Global search across all folders
- [ ] Email signatures
- [ ] Scheduled send
- [ ] Snooze messages
- [ ] Undo send (5–10s delay)
- [ ] Message preview line in list view
- [ ] Drag-to-resize panels
- [ ] Light theme toggle
- [ ] Mobile-responsive layout
- [ ] Virtual scrolling for large mailboxes
- [ ] Multi-account support
- [ ] PWA / offline support
- [ ] Two-factor authentication
- [ ] Export messages as .eml

## Contributing

NexusMail is under active development. Bug reports, feature requests, and pull requests are welcome at [GitHub Issues](https://github.com/brycebremer/NexusMail.cc/issues).

## License

[ISC](LICENSE) © Bryce Bremer
