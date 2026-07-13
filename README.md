# UserRadar

A Vencord plugin for keeping tabs on specific people on Discord. Add someone to your watchlist and UserRadar logs everything they do in the background — messages, voice activity, profile changes, status, music, games — and saves it all into a searchable activity log you can open anytime.

---

## Features

### 👀 Watchlist

- Add anyone by user ID or by right-clicking their profile
- Give people a custom nickname so you don't lose track of who's who
- Search through your list, sort by name or date added
- **Pin/favorite users** — pinned people always float to the top of the list regardless of sort order
- Each person can have their own tracking settings, independent of everyone else
- Auto-cleanup — logs for a person can be deleted automatically the moment you remove them from the watchlist (on by default, toggle in plugin settings)

### 📝 Message Tracking

- Logs every message sent by a watched user
- Logs edits with **before and after text shown side by side**
- Logs deletions (requires a message logger plugin to recover deleted content)
- Shows typing indicators if enabled
- Click any message log to jump straight to it in Discord

### 🎙️ Voice Tracking

- Tracks joining and leaving voice channels
- Live **"In #channel"** badge while they're still there
- Full join → left timeline with exact timestamps and duration
- Shows what platform they joined from (mobile / desktop / web)

### 🎵 Spotify & Activity Tracking

- Live "Now Playing" card with album art, artist, and a real-time progress bar
- Tracks games being played and streaming sessions
- Session duration and start/end times saved automatically
- A green **Live** badge appears on anything currently active

### 🟢 Status Tracking

- Online / idle / DND / offline changes
- Which platform they're using
- Custom status (the emoji + text people set manually) with before/after
- Smart enough to tell a real status change apart from someone briefly reconnecting — won't spam you every time their internet blips

### 🪪 Profile Tracking

Every profile field is tracked individually, each with a clean **before → after card**:

| Field | What you see |
|---|---|
| Avatar | Old and new profile picture side by side |
| Username | Old name struck through, new name highlighted |
| Display Name | Same before/after card |
| About Me / Bio | Full text comparison |
| Banner | Before/after |
| Pronouns | Before/after |

### 🔔 Notifications

Get a desktop notification the instant something happens. Fully customizable per category, with:
- **Quiet Hours** — mute notifications during set hours (e.g. 11pm–7am)
- **Silent Mode** — global presets to mute everything at once
- Spam protection so the same event never double-notifies you

### 📋 Activity Log

- **Quick stats header** — see messages sent, voice time, status changes, and total events for today at a glance
- Filter by category (messages, voice, profile, status, etc.) with one tap — the active filter blinks so you always know what you're looking at
- Search across your entire log
- Expand any card for full detail
- **Compact view** — toggle a denser layout to fit more on screen at once
- Export your log to a file — export everything, or just one category (messages only, voice only, etc.)
- Import a log back in
- Clear all logs whenever you want a fresh start

### ⚙️ Global Presets

Switch tracking behavior instantly with built-in modes:
- **Custom** — fully manual control over every toggle
- **Stalker** — track absolutely everything
- **Lite** — track only the essentials (messages, deletes, typing, avatar, voice, status)
- **Silent** — pause all notifications without losing any logged data

---

## Settings Reference

| Setting | Default | What it does |
|---|---|---|
| Messages | On | Logs sent messages |
| Edits | On | Logs edited messages with before/after |
| Deletes | On | Logs deleted messages (needs a message logger) |
| Typing | On | Logs typing indicators |
| Profile changes | On | Tracks username, display name, bio, banner, pronouns |
| Avatar changes | On | Tracks profile picture changes |
| Voice | On | Tracks voice channel join/leave |
| Status | Off | Tracks online/idle/dnd/offline (can be spammy) |
| Activity changes | Off | Tracks game/app activity changes (can be spammy) |
| Server joins/leaves | On | Tracks shared server join/leave events |
| Show message preview | On | Shows message content in notifications |
| Preview length | Unlimited | How much of a message to preview |
| Quiet hours | Off | Mutes notifications during a set time range |
| Skip current channel | On | Doesn't notify for activity in the channel you're already viewing |
| Toolbar icon | On | Shows the UserRadar icon in the chat toolbar |
| Max logs per user | 500 | Caps how many logs are kept per person (0 = unlimited) |
| Auto cleanup logs | On | Deletes a person's logs when removed from the watchlist |
| Compact log view | Off | Denser activity log cards |

Every setting above (except cleanup and compact view) can also be overridden per-person from the watchlist manager.

---

## How to Use

1. Open the watchlist manager from the toolbar icon
2. Add a user by ID, or right-click someone's profile and pick "Add to UserRadar"
3. Customize what you want tracked for them (or leave it on the global defaults)
4. Pin anyone you check often so they stay at the top of the list
5. Open the Activity Log anytime to see what they've been up to
6. Tap any card to expand it for full details

---

## Privacy

Everything is stored **locally on your device only**. UserRadar doesn't send your data anywhere — it only reads the same public profile and presence info Discord already shows you in the app.
