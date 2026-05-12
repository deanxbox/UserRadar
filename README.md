# 👁 UserRadar

A Vencord plugin that tracks users across Discord and notifies you when they do stuff.

---

## Features

### Message Tracking
- **Messages** — Get notified when a watched user sends a message
- **Edits** — Get notified when they edit a message
- **Deletes** — Get notified when they delete a message (works best with `vc-message-logger-enhanced` for deleted content)
- **Typing** — Get notified when they start typing in a channel

### Profile Tracking
- **Profile Changes** — Bio, banner, username, display name, accent color, banner color
- **Avatar Changes** — Separate notification with their new avatar as the icon

### Voice & Activity
- **Voice** — Joins, leaves, and channel moves
- **Status** — Online, idle, dnd, offline changes (off by default, spammy)
- **Activity** — Games, Spotify, Twitch/YouTube streams, competitions (off by default, spammy)

### Server Events
- **Boosts** — When they boost a server
- **Joins/Leaves** — When they join or leave a server you're in

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `globalMsgs` | ✅ | Notify on new messages |
| `globalEdits` | ✅ | Notify on edits |
| `globalDeletes` | ✅ | Notify on deletes |
| `globalTyping` | ✅ | Notify on typing |
| `globalProfile` | ✅ | Notify on profile changes |
| `globalAvatar` | ✅ | Notify on avatar changes |
| `globalVoice` | ✅ | Notify on voice activity |
| `globalStatus` | ❌ | Notify on status changes |
| `globalBoosts` | ✅ | Notify on server boosts |
| `globalJoins` | ✅ | Notify on server joins/leaves |
| `globalActivity` | ❌ | Notify on activity changes |
| `showPreview` | ✅ | Show message content in notifications |
| `previewLen` | 120 | Max characters in message preview |
| `quietHours` | ❌ | Silence notifications during set hours |
| `quietStart` | 23:00 | Quiet hours start |
| `quietEnd` | 07:00 | Quiet hours end |
| `skipCurrentChannel` | ✅ | Skip notification if you're already in that channel |
| `debugLog` | ❌ | Log all events to console |

---

## Per-User Overrides

Every tracked user has individual override toggles accessible from the watchlist modal. Click any user row to expand their override panel and toggle specific tracking features per-user.

Overrides available: Messages, Edits, Deletes, Typing, Profile, Avatar, Voice, Status, Boosts, Joins, Activity

---

## How to Use

1. **Right-click any user** → "👁 Watch User" to add them
2. **Open the watchlist** from plugin settings or right-click menu
3. **Paste a User ID** in the "Add User" section to track anyone
4. **Set labels** for users (private, only you see them)
5. **Toggle per-user overrides** by clicking a user row

---

## Requirements

- [Vencord](https://vencord.dev/) installed
- Optional: `vc-message-logger-enhanced` for deleted message content

---

## Install

This plugin requires **3 files** in your Vencord userplugins folder:

```
src/userplugins/UserRadar/
├── index.tsx    # main plugin logic + watchlist modal UI
├── store.ts     # state management helpers (getWatchlist, addUser, removeUser, etc.)
└── types.ts     # TypeScript type definitions
```

1. Create the folder `src/userplugins/UserRadar/`
2. Drop all 3 files into it
3. Build:
```bash
pnpm build
```
4. Reload Discord (Ctrl+R)

> ⚠️ **Note:** The plugin will **not** work with just `index.tsx` alone. `store.ts` and `types.ts` are required dependencies that handle watchlist persistence and type definitions.

---

## Credits

Made by **k1ng_op**
