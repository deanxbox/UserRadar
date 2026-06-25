# UserRadar

A powerful [Vencord](https://vencord.dev/) plugin for tracking specific Discord users and logging their activity — messages, edits, deletes, typing, profile changes, voice channel activity, status changes, game/music activity, and server joins/leaves.

> ⚠️ **Upgrading from a previous version?** If you are updating from an older version of UserRadar, please **clear all activity logs for all users** before using the new session tracking features. Old log entries are not compatible with the new session timeline and metadata format. If this is your first time installing UserRadar, you can ignore this message.

---

## Features

| Feature | Description |
|---------|-------------|
| **Message Tracking** | Log new messages, edits, and deleted messages (requires MessageLoggerEnhanced for deleted message recovery) |
| **Typing Indicators** | Get notified when a watched user starts typing |
| **Status Monitoring** | Track online/away/DND/offline transitions with session timelines |
| **Voice Activity** | Log voice channel joins, leaves, moves, camera toggles, and screen sharing sessions |
| **Game & Music Activity** | Track game sessions, Spotify/YouTube Music listening with album art and progress bars |
| **Profile Changes** | Detect avatar, banner, bio, username, and display name changes |
| **Server Joins/Leaves** | Monitor when watched users join or leave mutual servers |
| **Platform Detection** | See which platform (Desktop, Mobile, Web, Console, VR) the user is on |
| **Activity Log** | Full searchable, filterable, exportable activity history per user |
| **Per-User Controls** | Granular toggles for every feature on a per-user basis |
| **Quick Presets** | Stalker, Lite, and Silent presets for one-click configuration |
| **Quiet Hours** | Suppress notifications during configurable hours |
| **DM Toolbar Button** | Quick-access activity log button in DM headers |

---

## Presets

| Preset | Behavior |
|--------|----------|
| **Stalker** | Maximum tracking — every event logged and notified |
| **Lite** | Essential tracking only (messages, edits, deletes, typing, avatar, voice) |
| **Silent** | Log everything silently — no notifications, all events recorded |
| **Custom** | Per-user control — configure each feature individually |

---

## Installation

1. Install [Vencord](https://vencord.dev/)
2. Navigate to your Vencord userplugins folder:
   - **Vencord Desktop**: `%AppData%\Vencord\src\userplugins\`
3. Create a folder named `UserRadar`
4. Copy `index.tsx`, `store.ts`, and `types.ts` into the folder and `build`
5. Restart Discord — the plugin will appear in your Vencord plugins list

---

## Usage

### Adding Users

1. Open the **UserRadar** toolbar icon (eye icon in the top bar)
2. Paste a Discord User ID (enable Developer Mode → right-click user → Copy User ID)
3. Optionally add a private label (e.g., "bestie", "the rat", "ex")
4. Click **Look Up** then **Add to Watchlist**

### Context Menu Shortcuts

- Right-click any user → **Watch User** / **Unwatch User**
- Right-click any message → **Add Author to Watchlist**

### Activity Log

- Click **Activity** on any watched user to open their full history
- Filter by category (Messages, Edits, Deletes, Typing, Status, Voice, Profile, Activity)
- Search by content, app name, song, or artist
- Sort by newest or oldest
- Export/import as JSON
- **Delete individual entries** — hover any card and click the trash icon
- **Clear all logs** — use the Clear button in the footer

### Listening Sessions (Spotify/YouTube Music)

When a user starts listening to music, UserRadar creates a live session card with:
- Album artwork with dynamic color extraction
- Song name, artist, album
- Progress bar and duration
- Playlist/album context
- Platform badge

When the session ends, the card updates to show total listening time.

### Status Sessions

Online sessions track the full timeline:
- Start time and end time
- All status changes during the session (Online → Away → DND → Online)
- Platform switches (Desktop → Mobile → Web)
- Total duration

---

## Settings

| Setting | Description |
|---------|-------------|
| Messages | Track new messages |
| Edits | Track message edits |
| Deletes | Track deleted messages (requires MessageLoggerEnhanced) |
| Typing | Track typing indicators |
| Status | Track status changes (spammy — off by default) |
| Activity | Track game/music activity |
| Voice | Track voice channel activity |
| Profile | Track profile changes |
| Avatar | Track avatar updates |
| Joins/Leaves | Track server joins and leaves |
| Show Preview | Show message content in notifications |
| Preview Length | Truncate previews (0 = unlimited) |
| Quiet Hours | Suppress notifications during set hours |
| Skip Current Channel | Don't notify if you're already in the same channel |
| Toolbar Icon | Show/hide the toolbar button |

---

## Dependencies

- **Vencord** — the Discord client mod framework
- **MessageLoggerEnhanced** (optional) — for recovering deleted message content

---

## License

This plugin is provided as-is for personal use. Discord client modifications are against Discord's Terms of Service. Use at your own risk.

---

## Author

**k1ng_op** — built for stalking your **friends** ofc ;>
