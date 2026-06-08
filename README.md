# 👁 UserRadar

A Vencord / Equicord plugin that tracks users across Discord and notifies you when they do stuff.

---

## Features

### 💬 Messages
- New messages
- Edits
- Deletes *(content requires `vc-message-logger-enhanced`)*
- Typing indicators

### 👤 Profile
- Bio, banner, username, display name, accent color changes
- Avatar changes *(separate notification with new avatar as icon)*

### 🎙️ Voice
- Joins, leaves, channel moves
- Camera on / off
- Screen share / Go Live start / stop

### 🟢 Presence
- Status changes — Online, Away, Do Not Disturb, Offline
- Platform detection — Desktop 🖥️, Mobile 📱, Web 🌐, Console 🎮, VR 🥽
- Activity — games, Spotify, Twitch / YouTube streams, competitions

### 🏠 Server Events
- Server joins and leaves

---

## Notifications

### Status notification format
```
k1ng_op is now offline
was: Do Not Disturb from Desktop
```
The `from Desktop` part only shows when **Show Platform** is enabled. Platform is always recorded in the activity log regardless.

### Platform support
Discord exposes which client a user is on via presence data. UserRadar detects:

| Platform | Emoji | Discord internal name |
|---|---|---|
| Desktop | 🖥️ | `desktop` |
| Mobile | 📱 | `mobile` |
| Web | 🌐 | `web` |
| Console | 🎮 | `embedded` |
| VR | 🥽 | `vr` |

> Platform detection requires **Status** notifications to be enabled (globally or per-user), since platform data comes from presence events.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `globalMsgs` | ✅ | Notify on new messages |
| `globalEdits` | ✅ | Notify on message edits |
| `globalDeletes` | ✅ | Notify on deleted messages |
| `globalTyping` | ✅ | Notify when typing starts |
| `globalProfile` | ✅ | Notify on profile changes |
| `globalAvatar` | ✅ | Notify on avatar changes |
| `globalVoice` | ✅ | Notify on voice activity (joins, leaves, moves, camera, screen share) |
| `globalStatus` | ❌ | Notify on status changes *(spammy — off by default)* |
| `showPlatform` | ❌ | Show platform in notifications *(always shown in activity logs)* |
| `globalJoins` | ✅ | Notify on server joins / leaves |
| `showPreview` | ✅ | Show message content in notifications |
| `previewLen` | `0` | Max characters in message preview (`0` = no limit) |
| `quietHours` | ❌ | Silence notifications during set hours |
| `quietStart` | `23:00` | Quiet hours start time |
| `quietEnd` | `07:00` | Quiet hours end time |
| `skipCurrentChannel` | ✅ | Skip notification if you're already viewing that channel |
| `showToolbarIcon` | ✅ | Show watchlist button in the Discord toolbar |
| `debugLog` | ❌ | Log all events to the console |

---

## Per-User Overrides

Click any user row in the watchlist to expand their override panel. Every tracking feature can be toggled individually per user, independent of global settings.

**Quick presets:**
- **Stalker** — everything on
- **Lite** — messages, edits, deletes, typing, avatar, voice
- **Silent** — all notifications off

Overrides: Messages, Edits, Deletes, Typing, Profile, Avatar, Voice, Status, Activity, Joins

---

## Activity Log

Every event is logged and persisted to disk (unlimited history). Click **Activity** on any user row to open their full log.

- Filterable by type: All, Messages, Voice, Status, Profile, Activity
- Platform always shown in log entries regardless of the `showPlatform` toggle
- Searchable by keyword

---

## How to Use

1. **Right-click any user** → *👁 Watch User*
2. **Open the watchlist** from the toolbar icon or the right-click menu
3. **Add by ID** — paste any user ID in the Add User field to track someone not in your server
4. **Set a label** — private nickname only you see (e.g. `ex`, `snitch`, `rat from work`)
5. **Expand a row** — set per-user overrides and view their activity log

---

## Install

```bash
# drop files into your userplugins folder then build
pnpm build
```

Reload Discord with `Ctrl+R`.

---

## Requirements

- [Vencord](https://vencord.dev/) or [Equicord](https://github.com/Equicord/Equicord)
- Optional: `vc-message-logger-enhanced` for deleted message content

---

## Credits

Made by **k1ng_op**
