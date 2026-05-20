// === NEW: Persistent Activity Log System ===
// Added to store.ts or a new activityStore.ts

import { DataStore } from "@api/index";

const ACTIVITY_LOG_KEY = "UserRadar_ActivityLog";
const MAX_LOG_ENTRIES = 500; // per user

interface ActivityEntry {
    id: string;           // unique entry ID
    uid: string;          // user ID this entry belongs to
    ts: number;           // timestamp
    type: ActivityType;
    icon: string;         // emoji/icon
    title: string;        // short title
    body: string;         // detailed description
    guildId?: string;
    channelId?: string;
    msgId?: string;
    metadata?: Record<string, any>; // extra data (oldValue, newValue, etc.)
}

type ActivityType = 
    | "msg" | "edit" | "delete" | "typing"
    | "status" | "activity" | "voice"
    | "join" | "leave" | "boost"
    | "profile" | "avatar" | "banner" | "bio" | "username" | "displayname"
    | "online" | "offline" | "idle" | "dnd"
    | "game_start" | "game_stop" | "spotify" | "streaming"
    | "vc_join" | "vc_leave" | "vc_move"
    | "reaction" | "nickname" | "role";

// Persistent storage using DataStore (survives restarts)
class ActivityStore {
    private cache: Record<string, ActivityEntry[]> = {};
    private loaded = false;

    async load() {
        if (this.loaded) return;
        try {
            const data = await DataStore.get(ACTIVITY_LOG_KEY);
            if (data) this.cache = JSON.parse(data);
        } catch (e) { console.error("[UserRadar] Failed to load activity log", e); }
        this.loaded = true;
    }

    async save() {
        try {
            await DataStore.set(ACTIVITY_LOG_KEY, JSON.stringify(this.cache));
        } catch (e) { console.error("[UserRadar] Failed to save activity log", e); }
    }

    getLogs(uid: string): ActivityEntry[] {
        return this.cache[uid] || [];
    }

    async addLog(entry: Omit<ActivityEntry, "id">) {
        await this.load();
        if (!this.cache[entry.uid]) this.cache[entry.uid] = [];

        const fullEntry: ActivityEntry = {
            ...entry,
            id: `${entry.uid}_${entry.ts}_${Math.random().toString(36).slice(2, 8)}`,
        };

        this.cache[entry.uid].unshift(fullEntry);

        // Trim to max entries
        if (this.cache[entry.uid].length > MAX_LOG_ENTRIES) {
            this.cache[entry.uid] = this.cache[entry.uid].slice(0, MAX_LOG_ENTRIES);
        }

        await this.save();
        return fullEntry;
    }

    async clearLogs(uid: string) {
        await this.load();
        delete this.cache[uid];
        await this.save();
    }

    async clearAll() {
        this.cache = {};
        await DataStore.del(ACTIVITY_LOG_KEY);
    }

    // Export for backup
    exportAll(): string {
        return JSON.stringify(this.cache, null, 2);
    }

    // Import from backup
    async importAll(json: string) {
        try {
            this.cache = JSON.parse(json);
            await this.save();
            return true;
        } catch { return false; }
    }
}

export const activityStore = new ActivityStore();

// === ENHANCED: Activity Logger Helper ===
// Replaces the old logActivity function

export async function logUserActivity(
    uid: string,
    type: ActivityType,
    icon: string,
    title: string,
    body: string,
    options?: {
        guildId?: string;
        channelId?: string;
        msgId?: string;
        metadata?: Record<string, any>;
    }
) {
    const entry = await activityStore.addLog({
        uid,
        ts: Date.now(),
        type,
        icon,
        title,
        body,
        ...options,
    });

    // Also emit to any live listeners (for real-time UI updates)
    emitActivityUpdate(uid, entry);

    return entry;
}

// Event emitter for live updates
const activityListeners = new Set<(uid: string, entry: ActivityEntry) => void>();

export function onActivityUpdate(cb: (uid: string, entry: ActivityEntry) => void) {
    activityListeners.add(cb);
    return () => activityListeners.delete(cb);
}

function emitActivityUpdate(uid: string, entry: ActivityEntry) {
    activityListeners.forEach(cb => cb(uid, entry));
}

// === ENHANCED: Profile Change Detection with Metadata ===
// Enhanced checkProfileChanged with detailed logging

const PROFILE_FIELD_NAMES: Record<string, string> = {
    username: "Username",
    globalName: "Display Name", 
    bio: "Bio",
    banner: "Banner",
    avatar: "Avatar",
    accentColor: "Accent Color",
    bannerColor: "Banner Color",
    pronouns: "Pronouns",
};

async function checkProfileChangedEnhanced(uid: string, fresh: any) {
    if (!isWatched(settings, uid)) return;

    const old = profileCache[uid];
    if (!old) {
        profileCache[uid] = fresh;
        return;
    }

    const user = fresh.user || fresh;
    const oldUser = old.user || old;

    // Check each field individually for granular logging
    const fieldsToCheck = [
        { key: "avatar", type: "avatar" as ActivityType, icon: "🖼️" },
        { key: "banner", type: "banner" as ActivityType, icon: "🏳️" },
        { key: "bio", type: "bio" as ActivityType, icon: "📝" },
        { key: "username", type: "username" as ActivityType, icon: "🏷️" },
        { key: "globalName", type: "displayname" as ActivityType, icon: "📛" },
        { key: "pronouns", type: "profile" as ActivityType, icon: "⚧️" },
    ];

    for (const field of fieldsToCheck) {
        const oldVal = oldUser?.[field.key];
        const newVal = user?.[field.key];

        if (oldVal !== newVal && (oldVal !== undefined || newVal !== undefined)) {
            // Log the specific change
            const label = getWatchedUser(settings, uid)?.nick;
            const name = displayName(user) || uid;
            const dn = label ? `${label} (${name})` : name;
            const fieldName = PROFILE_FIELD_NAMES[field.key] || field.key;

            await logUserActivity(
                uid,
                field.type,
                field.icon,
                `${dn} changed their ${fieldName.toLowerCase()}`,
                oldVal ? `From: ${trunc(String(oldVal), 50)}` : "Added new content",
                {
                    metadata: {
                        field: field.key,
                        oldValue: oldVal,
                        newValue: newVal,
                        changedAt: Date.now(),
                    }
                }
            );

            // Send notification if enabled
            const notifKey = field.key === "avatar" ? "avatar" : "profile";
            if (isFeatureOn(uid, notifKey as any, `global${notifKey.charAt(0).toUpperCase() + notifKey.slice(1)}`)) {
                notify({
                    title: `${dn} changed their ${fieldName.toLowerCase()}`,
                    body: oldVal ? `From: ${trunc(String(oldVal), 60)}` : "Click to view",
                    icon: avatarUrl(uid, user?.avatar, 80),
                    onClick: () => openUserProfile(uid),
                });
            }
        }
    }

    profileCache[uid] = fresh;
}

// === ENHANCED: Status Change Logging ===
// Enhanced PRESENCE_UPDATES handler with detailed status logging

async function handlePresenceUpdate(uid: string, update: any) {
    const oldStatus = statusCache[uid];
    const newStatus = update.status;
    const user = UserStore.getUser(uid);
    const label = getWatchedUser(settings, uid)?.nick;
    const name = displayName(user) || uid;
    const dn = label ? `${label} (${name})` : name;

    // Status transition logging
    if (oldStatus !== undefined && oldStatus !== newStatus) {
        const statusTypeMap: Record<string, ActivityType> = {
            online: "online",
            offline: "offline", 
            idle: "idle",
            dnd: "dnd",
        };

        const statusIcons: Record<string, string> = {
            online: "🟢",
            offline: "⚫",
            idle: "🌙",
            dnd: "🔴",
        };

        const statusLabels: Record<string, string> = {
            online: "Online",
            offline: "Offline",
            idle: "Idle",
            dnd: "Do Not Disturb",
        };

        await logUserActivity(
            uid,
            statusTypeMap[newStatus] || "status",
            statusIcons[newStatus] || "🔵",
            `${dn} is now ${statusLabels[newStatus] || newStatus}`,
            `Status changed from ${oldStatus} to ${newStatus}`,
            {
                metadata: {
                    oldStatus,
                    newStatus,
                    duration: oldStatus ? Date.now() - (statusTimestamps[uid]?.[oldStatus] || Date.now()) : undefined,
                }
            }
        );

        if (isFeatureOn(uid, "status", "globalStatus")) {
            notify({
                title: `${dn} is now ${newStatus}`,
                body: `Was ${oldStatus}`,
                icon: avatarUrl(uid, (user as any)?.avatar, 80),
                onClick: () => openUserProfile(uid),
            });
        }
    }

    statusCache[uid] = newStatus;
    if (!statusTimestamps[uid]) statusTimestamps[uid] = {};
    statusTimestamps[uid][newStatus] = Date.now();

    // Activity/Game logging
    const realAct = (update.activities || []).find((a: any) => a.type !== 4) ?? null;
    const newActKey = realAct ? `${realAct.type}:${realAct.name}` : null;
    const oldAct = activityCache[uid];

    if (oldAct !== undefined && oldAct !== newActKey) {
        const ACT_TYPE_MAP: Record<number, ActivityType> = {
            0: "game_start",
            2: "spotify", 
            3: "streaming",
            5: "game_start",
        };

        const ACT_VERB: Record<number, string> = {
            0: "playing",
            2: "listening to",
            3: "watching",
            5: "competing in",
        };

        const ACT_ICON: Record<number, string> = {
            0: "🎮",
            2: "🎵",
            3: "📺",
            5: "🏆",
        };

        if (realAct) {
            const type = ACT_TYPE_MAP[realAct.type] || "game_start";
            const verb = ACT_VERB[realAct.type] || "playing";
            const icon = ACT_ICON[realAct.type] || "🎮";

            await logUserActivity(
                uid,
                type,
                icon,
                `${dn} is ${verb} ${realAct.name}`,
                [realAct.details, realAct.state].filter(Boolean).join(" · ") || "",
                {
                    metadata: {
                        activityType: realAct.type,
                        activityName: realAct.name,
                        details: realAct.details,
                        state: realAct.state,
                        applicationId: realAct.application_id,
                        sessionId: realAct.session_id,
                        timestamps: realAct.timestamps,
                    }
                }
            );
        } else if (oldAct) {
            const [typeStr, ...nameParts] = oldAct.split(":");
            const oldName = nameParts.join(":");

            await logUserActivity(
                uid,
                "game_stop",
                "🛑",
                `${dn} stopped playing ${oldName}`,
                `Was active for ${formatDuration(activityDurations[uid]?.[oldAct] || 0)}`,
                {
                    metadata: {
                        oldActivity: oldAct,
                        duration: activityDurations[uid]?.[oldAct],
                    }
                }
            );
        }
    }

    activityCache[uid] = newActKey;
    if (newActKey) {
        if (!activityDurations[uid]) activityDurations[uid] = {};
        activityDurations[uid][newActKey] = Date.now();
    }
}

// Helper for duration formatting
function formatDuration(ms: number): string {
    if (!ms) return "unknown";
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    if (hours > 0) return `${hours}h ${mins % 60}m`;
    return `${mins}m`;
}

// === NEW: Activity Tab in User Profile ===
// Component to show in Discord's user profile modal

function UserRadarActivityTab({ userId }: { userId: string }) {
    const [logs, setLogs] = React.useState<ActivityEntry[]>([]);
    const [filter, setFilter] = React.useState<ActivityType | "all">("all");
    const [expandedEntry, setExpandedEntry] = React.useState<string | null>(null);

    React.useEffect(() => {
        // Load logs
        const load = async () => {
            await activityStore.load();
            setLogs(activityStore.getLogs(userId));
        };
        load();

        // Subscribe to live updates
        const unsub = onActivityUpdate((uid, entry) => {
            if (uid === userId) {
                setLogs(prev => [entry, ...prev].slice(0, MAX_LOG_ENTRIES));
            }
        });

        return unsub;
    }, [userId]);

    const filtered = filter === "all" ? logs : logs.filter(l => l.type === filter);

    // Group by date
    const grouped = filtered.reduce((acc, log) => {
        const date = new Date(log.ts).toLocaleDateString();
        if (!acc[date]) acc[date] = [];
        acc[date].push(log);
        return acc;
    }, {} as Record<string, ActivityEntry[]>);

    const filters: { type: ActivityType | "all"; label: string; icon: string }[] = [
        { type: "all", label: "All", icon: "📋" },
        { type: "msg", label: "Messages", icon: "💬" },
        { type: "status", label: "Status", icon: "🔵" },
        { type: "voice", label: "Voice", icon: "🎙️" },
        { type: "profile", label: "Profile", icon: "👤" },
        { type: "activity", label: "Activity", icon: "🎮" },
    ];

    return (
        <div style={{ padding: "16px" }}>
            {/* Filter tabs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                {filters.map(f => (
                    <div
                        key={f.type}
                        onClick={() => setFilter(f.type)}
                        style={{
                            padding: "6px 12px",
                            borderRadius: 12,
                            background: filter === f.type ? "#5865f2" : "#2b2d31",
                            color: filter === f.type ? "#fff" : "#949ba4",
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            transition: "all 150ms ease",
                        }}
                    >
                        <span>{f.icon}</span>
                        <span>{f.label}</span>
                        <span style={{ 
                            background: filter === f.type ? "rgba(255,255,255,0.2)" : "#1e1f22",
                            padding: "2px 6px",
                            borderRadius: 8,
                            fontSize: 10,
                        }}>
                            {f.type === "all" ? logs.length : logs.filter(l => l.type === f.type).length}
                        </span>
                    </div>
                ))}
            </div>

            {/* Stats summary */}
            <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 8,
                marginBottom: 16,
            }}>
                {[
                    { label: "Total Events", value: logs.length, color: "#5865f2" },
                    { label: "Today", value: logs.filter(l => new Date(l.ts).toDateString() === new Date().toDateString()).length, color: "#23a55a" },
                    { label: "This Week", value: logs.filter(l => Date.now() - l.ts < 7 * 86400000).length, color: "#f0b232" },
                    { label: "Online Time", value: calculateOnlineTime(logs), color: "#949cf4" },
                ].map(stat => (
                    <div key={stat.label} style={{
                        background: "#2b2d31",
                        borderRadius: 12,
                        padding: "12px",
                        border: "1px solid #3f4147",
                    }}>
                        <div style={{ fontSize: 20, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                        <div style={{ fontSize: 11, color: "#949ba4", marginTop: 4 }}>{stat.label}</div>
                    </div>
                ))}
            </div>

            {/* Activity timeline */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {Object.entries(grouped).map(([date, dayLogs]) => (
                    <div key={date}>
                        <div style={{
                            fontSize: 11,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            letterSpacing: 0.8,
                            color: "#949ba4",
                            marginBottom: 8,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                        }}>
                            <span>{date === new Date().toLocaleDateString() ? "Today" : date}</span>
                            <span style={{ flex: 1, height: 1, background: "#3f4147" }} />
                            <span>{dayLogs.length} events</span>
                        </div>

                        {dayLogs.map((log, i) => (
                            <div
                                key={log.id}
                                onClick={() => setExpandedEntry(expandedEntry === log.id ? null : log.id)}
                                style={{
                                    display: "flex",
                                    gap: 12,
                                    padding: "10px 12px",
                                    borderRadius: 10,
                                    background: "#2b2d31",
                                    border: "1px solid #3f4147",
                                    marginBottom: 6,
                                    cursor: "pointer",
                                    transition: "all 150ms ease",
                                }}
                            >
                                <div style={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: "50%",
                                    background: "#1e1f22",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: 16,
                                    flexShrink: 0,
                                }}>
                                    {log.icon}
                                </div>

                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{
                                        fontSize: 13,
                                        fontWeight: 600,
                                        color: "#dbdee1",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                    }}>
                                        <span>{log.title}</span>
                                        <span style={{
                                            fontSize: 10,
                                            color: "#949ba4",
                                            fontWeight: 500,
                                        }}>
                                            {timeAgo(log.ts)}
                                        </span>
                                    </div>

                                    <div style={{
                                        fontSize: 12,
                                        color: "#949ba4",
                                        marginTop: 2,
                                        lineHeight: 1.4,
                                    }}>
                                        {log.body}
                                    </div>

                                    {/* Expanded metadata */}
                                    {expandedEntry === log.id && log.metadata && (
                                        <div style={{
                                            marginTop: 8,
                                            padding: "8px 12px",
                                            background: "#1e1f22",
                                            borderRadius: 8,
                                            fontSize: 11,
                                            color: "#949ba4",
                                            fontFamily: "monospace",
                                            lineHeight: 1.6,
                                        }}>
                                            {Object.entries(log.metadata).map(([key, val]) => (
                                                <div key={key} style={{ display: "flex", gap: 8 }}>
                                                    <span style={{ color: "#5865f2", minWidth: 100 }}>{key}:</span>
                                                    <span style={{ 
                                                        color: "#dbdee1",
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                    }}>
                                                        {typeof val === "object" ? JSON.stringify(val) : String(val)}
                                                    </span>
                                                </div>
                                            ))}

                                            {/* Jump to Discord button */}
                                            {(log.channelId || log.guildId) && (
                                                <div
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        jumpTo(log.guildId, log.channelId, log.msgId);
                                                    }}
                                                    style={{
                                                        marginTop: 8,
                                                        padding: "6px 12px",
                                                        background: "#5865f2",
                                                        borderRadius: 8,
                                                        color: "#fff",
                                                        fontSize: 12,
                                                        fontWeight: 600,
                                                        cursor: "pointer",
                                                        textAlign: "center",
                                                        fontFamily: "inherit",
                                                    }}
                                                >
                                                    Jump to Discord
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div style={{
                                    color: "#949ba4",
                                    fontSize: 10,
                                    flexShrink: 0,
                                    opacity: 0.6,
                                }}>
                                    {new Date(log.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </div>
                            </div>
                        ))}
                    </div>
                ))}

                {logs.length === 0 && (
                    <div style={{
                        textAlign: "center",
                        padding: "40px 0",
                        color: "#949ba4",
                    }}>
                        <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.5 }}>📭</div>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>No activity tracked yet</div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>Events will appear here once this user does something</div>
                    </div>
                )}
            </div>

            {/* Export button */}
            {logs.length > 0 && (
                <div style={{
                    marginTop: 16,
                    display: "flex",
                    gap: 8,
                    justifyContent: "flex-end",
                }}>
                    <button
                        onClick={() => {
                            const data = activityStore.exportAll();
                            const blob = new Blob([data], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `userradar_activity_${userId}_${new Date().toISOString().slice(0,10)}.json`;
                            a.click();
                            URL.revokeObjectURL(url);
                        }}
                        style={{
                            padding: "8px 16px",
                            borderRadius: 20,
                            background: "transparent",
                            border: "1px solid #3f4147",
                            color: "#949ba4",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "inherit",
                        }}
                    >
                        Export JSON
                    </button>
                    <button
                        onClick={async () => {
                            if (confirm("Clear all activity history for this user? This cannot be undone.")) {
                                await activityStore.clearLogs(userId);
                                setLogs([]);
                            }
                        }}
                        style={{
                            padding: "8px 16px",
                            borderRadius: 20,
                            background: "transparent",
                            border: "1px solid #da373c",
                            color: "#da373c",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "inherit",
                        }}
                    >
                        Clear History
                    </button>
                </div>
            )}
        </div>
    );
}

function calculateOnlineTime(logs: ActivityEntry[]): string {
    let totalMs = 0;
    let lastOnline: number | null = null;

    // Sort by time ascending
    const sorted = [...logs].sort((a, b) => a.ts - b.ts);

    for (const log of sorted) {
        if (log.type === "online") {
            lastOnline = log.ts;
        } else if (log.type === "offline" && lastOnline) {
            totalMs += log.ts - lastOnline;
            lastOnline = null;
        }
    }

    // If currently online, add time since last online
    if (lastOnline && logs[0]?.type === "online") {
        totalMs += Date.now() - lastOnline;
    }

    const hours = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);

    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// === PATCH: Add Activity Tab to Discord User Profile ===
// This patches the user profile modal to add our tab

const profileTabPatch: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user) return;

    // Find the tab list in the profile modal
    const tabList = children.find(c => c?.props?.className?.includes("tabBar") || c?.type?.displayName?.includes("TabBar"));
    if (!tabList) return;

    // Add our tab
    const originalTabs = tabList.props.children || [];
    tabList.props.children = [
        ...originalTabs,
        <div
            key="userradar-activity"
            className="tabBarItem"
            onClick={() => {
                // Set active tab state
                const content = document.querySelector('[class*="userProfileModalInner"]');
                if (content) {
                    // Remove existing content
                    const existing = content.querySelector('[class*="userRadarActivity"]');
                    if (existing) existing.remove();

                    // Add our content
                    const container = document.createElement("div");
                    container.className = "userRadarActivity";
                    content.appendChild(container);

                    // Render React component
                    const root = (window as any).ReactDOM?.createRoot?.(container);
                    if (root) {
                        root.render(<UserRadarActivityTab userId={user.id} />);
                    }
                }
            }}
            style={{
                padding: "8px 16px",
                cursor: "pointer",
                color: "#949ba4",
                fontSize: 14,
                fontWeight: 600,
                borderBottom: "2px solid transparent",
                transition: "all 150ms ease",
            }}
            onMouseEnter={e => {
                e.currentTarget.style.color = "#dbdee1";
            }}
            onMouseLeave={e => {
                e.currentTarget.style.color = "#949ba4";
            }}
        >
            Activity Log
            {activityStore.getLogs(user.id).length > 0 && (
                <span style={{
                    marginLeft: 6,
                    background: "#5865f2",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 800,
                    padding: "2px 6px",
                    borderRadius: 8,
                }}>
                    {activityStore.getLogs(user.id).length}
                </span>
            )}
        </div>,
    ];
};

// Register the patch
// addContextMenuPatch("user-profile-modal", profileTabPatch);
