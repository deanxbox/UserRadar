/*
 * UserRadar - a Vencord plugin by Mubashir
 *
 * get notified whenever someone you're watching does anything on discord
 * messages, edits, deletes, typing, profile changes, voice, status - all of it
 *
 * needs vc-message-logger-enhanced for delete tracking to work properly
 * without it deletes will only fire if discord still has the msg cached
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu"
import { Notifications } from "@api/index"
import { definePluginSettings } from "@api/Settings"
import { getCurrentChannel, openUserProfile } from "@utils/discord"
import { openModal, ModalRoot, ModalHeader, ModalContent, ModalSize } from "@utils/modal"
import definePlugin, { OptionType } from "@utils/types"
import { findByProps } from "@webpack"
import {
    ChannelStore, Menu, MessageStore,
    React, RestAPI, Text, Toasts, UserStore
} from "@webpack/common"
import { Message } from "discord-types/general"

import {
    MsgCreateEvent, MsgDeleteEvent, MsgUpdateEvent,
    PresenceEvent, ProfileFetchEvent, ThreadCreateEvent,
    TypingEvent, VoiceStateEvent
} from "./types"

import {
    addUser, camelize, displayName, featureOn,
    getWatchedUser, getWatchlist, inQuietHours,
    isWatched, log, removeUser, STATUS_EMOJI
} from "./store"

import { WatchedUser } from "./types"

// ---------- runtime state ----------

const profileCache: Record<string, ProfileFetchEvent> = {}
const vcCache: Record<string, string | null> = {}
const statusCache: Record<string, string> = {}
let loggedMsgs: Record<string, Message> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

// ---------- logger plugin hook ----------

async function tryLoadLoggedMsgs() {
    if (loggedMsgs) return loggedMsgs
    for (const prefix of ["plugins", "userplugins"]) {
        try {
            // @ts-ignore dynamic import path
            const m = await import(`${prefix}/vc-message-logger-enhanced/LoggedMessageManager`)
            loggedMsgs = m.loggedMessages ?? null
            return loggedMsgs
        } catch { /* try next */ }
    }
    return null
}

// ---------- settings ----------

const settings = definePluginSettings({
    watchlist: {
        type: OptionType.STRING,
        default: "[]",
        description: "Watched users list (JSON - managed by the UI below, don't edit manually)",
        hidden: true,
    },
    globalMsgs: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify on new messages",
    },
    globalEdits: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify on message edits",
    },
    globalDeletes: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify on message deletes (requires vc-message-logger-enhanced)",
    },
    globalTyping: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify when someone starts typing",
    },
    globalProfile: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify on profile changes (avatar, bio, banner, etc.)",
    },
    globalVoice: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify on voice channel joins / leaves / moves",
    },
    globalStatus: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Notify on status changes (can be noisy, off by default)",
    },
    showPreview: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show message content in notifications",
    },
    previewLen: {
        type: OptionType.NUMBER,
        default: 120,
        description: "Max chars to show in message preview (0 = no limit)",
    },
    quietHours: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Mute all notifications during a set time window",
    },
    quietStart: {
        type: OptionType.STRING,
        default: "23:00",
        description: "Quiet hours start time (24h, e.g. 23:00)",
    },
    quietEnd: {
        type: OptionType.STRING,
        default: "07:00",
        description: "Quiet hours end time (24h, e.g. 07:00)",
    },
    skipCurrentChannel: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Don't notify if you're already looking at the same channel",
    },
    debugLog: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Print all tracked events to the console (for debugging)",
    },
})

// ---------- notification helpers ----------

function truncate(s: string, max: number): string {
    if (max <= 0 || s.length <= max) return s
    return s.slice(0, max) + "…"
}

function msgPreview(content: string, filename?: string): string {
    if (!settings.store.showPreview) return "Click to jump"
    const base = content || filename || "Click to jump"
    return truncate(base, settings.store.previewLen)
}

function jumpTo(guildId?: string, channelId?: string, msgId?: string) {
    if (guildId) findByProps("transitionToGuildSync")?.transitionToGuildSync(guildId)
    if (channelId) findByProps("selectChannel")?.selectChannel({
        guildId: guildId ?? "@me",
        channelId,
        messageId: msgId,
    })
}

function push(opts: { title: string; body: string; icon?: string; onClick?: () => void }) {
    if (inQuietHours(settings)) return
    if (settings.store.debugLog) log.info(`notif: ${opts.title} — ${opts.body}`)

    if (document.hasFocus()) {
        Notifications.showNotification({
            title: opts.title,
            body: opts.body,
            icon: opts.icon,
            onClick: opts.onClick,
        })
    } else {
        try {
            const n = new window.Notification(opts.title, { body: opts.body, icon: opts.icon })
            if (opts.onClick) { n.onclick = () => { window.focus(); opts.onClick!() } }
        } catch {
            Notifications.showNotification({ title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick })
        }
    }
}

// ---------- profile change detection ----------

const PROFILE_FIELDS = ["username", "globalName", "avatar", "bio", "banner", "bannerColor", "accentColor"] as const
const FIELD_LABELS: Record<string, string> = {
    username: "username", globalName: "display name", avatar: "avatar",
    bio: "bio", banner: "banner", bannerColor: "banner color", accentColor: "accent color",
}

function checkProfileChanged(uid: string, freshData: ProfileFetchEvent) {
    if (!isWatched(settings, uid)) return
    if (!featureOn(settings, uid, "profile", "globalProfile")) return
    const old = profileCache[uid]
    if (!old) { profileCache[uid] = freshData; return }
    const changed = PROFILE_FIELDS.filter(f => (freshData.user as any)[f] !== (old.user as any)[f])
    if (changed.length === 0) return
    const u = UserStore.getUser(uid)
    const name = displayName(freshData.user)
    const label = getWatchedUser(settings, uid)?.nick
    push({
        title: `${label ? `${label} (${name})` : name} updated their profile`,
        body: `Changed: ${changed.map(f => FIELD_LABELS[f]).join(", ")}`,
        icon: u?.getAvatarURL(undefined, undefined, false),
        onClick: () => openUserProfile(uid),
    })
    profileCache[uid] = freshData
}

const POLL_INTERVAL = 5 * 60 * 1000

async function pollProfiles() {
    const list = getWatchlist(settings)
    if (list.length === 0) return
    log.info(`polling profiles for ${list.length} watched user(s)`)
    for (const wu of list) {
        try {
            const { body } = await RestAPI.get({
                url: `/users/${wu.id}/profile`,
                query: { with_mutual_guilds: false, with_mutual_friends_count: false },
            })
            checkProfileChanged(wu.id, camelize(body))
        } catch { /* skip */ }
        await new Promise(r => setTimeout(r, 1500))
    }
}

// ============================================================
// WATCHLIST MODAL — inlined to avoid cross-file import issues
// ============================================================

const MODAL_STYLE_ID = "ur-s5"
function injectModalStyles() {
    if (document.getElementById(MODAL_STYLE_ID)) return
    const el = document.createElement("style")
    el.id = MODAL_STYLE_ID
    el.textContent = `
        @keyframes ur-in   { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
        @keyframes ur-spin { to{transform:rotate(360deg)} }
        .ur-card {
            border-radius:10px; overflow:hidden; margin-bottom:8px;
            border:1px solid var(--background-modifier-accent);
            background:var(--background-secondary);
            transition:border-color .15s,box-shadow .15s;
            animation:ur-in .15s ease;
        }
        .ur-card:hover { border-color:rgba(88,101,242,.4); box-shadow:0 2px 12px rgba(0,0,0,.15); }
        .ur-spinner {
            display:inline-block;width:12px;height:12px;border-radius:50%;
            border:2px solid rgba(255,255,255,.3);border-top-color:#fff;
            animation:ur-spin .6s linear infinite;vertical-align:middle;
        }
    `
    document.head.appendChild(el)
}

function safeAvatarUrl(id: string, hash?: string | null, size = 80): string {
    try {
        if (hash) {
            const ext = hash.startsWith("a_") ? "gif" : "webp"
            return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=${size}`
        }
        let idx = 0
        try { idx = Number(BigInt(id) % BigInt(6)) } catch { idx = parseInt(id.slice(-1), 10) % 6 || 0 }
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`
    } catch { return "https://cdn.discordapp.com/embed/avatars/0.png" }
}

function userAvatarUrl(du: any, userId: string, size = 64): string {
    if (!du) return safeAvatarUrl(userId, null, size)
    try { return safeAvatarUrl(du.id ?? userId, du.avatar ?? null, size) }
    catch { return safeAvatarUrl(userId, null, size) }
}

function bannerCdnUrl(id: string, hash?: string | null): string | null {
    if (!hash) return null
    try { return `https://cdn.discordapp.com/banners/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=480` }
    catch { return null }
}

function toHexColor(n?: number | null): string | null {
    if (n == null) return null
    try { return "#" + n.toString(16).padStart(6, "0") } catch { return null }
}

function UrClickable({ onClick, style, title, children }: {
    onClick: () => void; style?: any; title?: string; children: any
}) {
    return (
        <div
            role="button" tabIndex={0} title={title}
            onClick={onClick}
            onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
            style={{ cursor: "pointer", userSelect: "none", ...style }}
        >
            {children}
        </div>
    )
}

function UrToggle({ on, onChange }: { on: boolean; onChange: () => void }) {
    return (
        <UrClickable
            onClick={onChange}
            style={{
                position: "relative", width: 32, height: 18, borderRadius: 9,
                background: on ? "var(--brand-500)" : "var(--background-modifier-accent)",
                flexShrink: 0, transition: "background .15s",
            }}
        >
            <div style={{
                position: "absolute", top: 2, left: on ? 16 : 2,
                width: 14, height: 14, borderRadius: "50%",
                background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)",
                transition: "left .15s",
            }} />
        </UrClickable>
    )
}

function UrTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: any }) {
    return (
        <UrClickable
            onClick={onClick}
            style={{
                flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 8,
                fontSize: 13, fontWeight: active ? 600 : 500,
                color: active ? "var(--header-primary)" : "var(--text-muted)",
                background: active ? "var(--background-primary)" : "transparent",
                boxShadow: active ? "0 1px 4px rgba(0,0,0,.2)" : "none",
                transition: "background .12s, color .12s",
            }}
        >
            {children}
        </UrClickable>
    )
}

function UrIconAction({ onClick, title, danger, children }: {
    onClick: () => void; title?: string; danger?: boolean; children: any
}) {
    const [hov, setHov] = React.useState(false)
    return (
        <div
            role="button" tabIndex={0} title={title}
            onMouseEnter={() => setHov(true)}
            onMouseLeave={() => setHov(false)}
            onClick={onClick}
            onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
            style={{
                cursor: "pointer", userSelect: "none",
                padding: "5px 7px", borderRadius: 6, fontSize: 15, lineHeight: 1,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                color: (danger && hov) ? "var(--status-danger)" : hov ? "var(--interactive-hover)" : "var(--interactive-normal)",
                background: (danger && hov) ? "rgba(237,66,69,.1)" : hov ? "var(--background-modifier-hover)" : "transparent",
                transition: "background .12s, color .12s",
            }}
        >
            {children}
        </div>
    )
}

const OVERRIDE_ITEMS = [
    { label: "Messages", icon: "💬", key: "msgs",    gk: "globalMsgs"    },
    { label: "Edits",    icon: "✏️",  key: "edits",   gk: "globalEdits"   },
    { label: "Deletes",  icon: "🗑",  key: "deletes", gk: "globalDeletes" },
    { label: "Typing",   icon: "⌨️",  key: "typing",  gk: "globalTyping"  },
    { label: "Profile",  icon: "🪪",  key: "profile", gk: "globalProfile" },
    { label: "Voice",    icon: "🎙",  key: "voice",   gk: "globalVoice"   },
    { label: "Status",   icon: "🟢",  key: "status",  gk: "globalStatus"  },
] as const

function UrChip({ on, overridden, icon, label, onClick, onRightClick }: {
    on: boolean; overridden: boolean; icon: string; label: string; onClick: () => void; onRightClick: () => void
}) {
    return (
        <UrClickable
            onClick={onClick}
            style={{
                display: "flex", alignItems: "center", gap: 7, padding: "8px 10px", borderRadius: 8,
                border: `1.5px solid ${on ? "rgba(88,101,242,.45)" : "var(--background-modifier-accent)"}`,
                background: on ? "rgba(88,101,242,.1)" : "var(--background-tertiary)",
                opacity: on ? 1 : 0.6, transition: "all .12s",
            }}
            title={overridden ? "Overriding global — right-click to reset" : "Click to override global setting"}
        >
            <div style={{ display: "contents" }} onContextMenu={(e: any) => { e.preventDefault(); onRightClick() }}>
                <span style={{ fontSize: 13 }}>{icon}</span>
                <span style={{ flex: 1, fontSize: 12, fontWeight: 500, color: on ? "var(--text-normal)" : "var(--text-muted)" }}>
                    {label}
                </span>
                {overridden && <span style={{ fontSize: 7, color: "var(--brand-400)", marginRight: 2 }}>●</span>}
                <UrToggle on={on} onChange={onClick} />
            </div>
        </UrClickable>
    )
}

function UrUserCard({ user, onUpdate, onRemove }: {
    user: WatchedUser; onUpdate: () => void; onRemove: () => void
}) {
    const [nick,     setNick]     = React.useState(user.nick ?? "")
    const [expanded, setExpanded] = React.useState(false)
    const [editNick, setEditNick] = React.useState(false)

    const du   = React.useMemo(() => { try { return UserStore.getUser(user.id) ?? null } catch { return null } }, [user.id])
    const av   = userAvatarUrl(du, user.id, 64)
    const name = (du ? displayName(du) : null) || user.nick || user.id
    const ovs  = user.overrides ?? {}
    const hasOv = Object.values(ovs).some((v: any) => v !== null && v !== undefined)

    const saveNick = () => {
        patchUser(settings, user.id, { nick: nick.trim() })
        setEditNick(false)
        onUpdate()
    }

    const setOv = (key: string, val: boolean | null) => {
        patchUser(settings, user.id, { overrides: { ...ovs, [key]: val } as any })
        onUpdate()
    }

    const addedDate = React.useMemo(() => {
        try { return new Date(user.addedAt).toLocaleDateString() } catch { return "—" }
    }, [user.addedAt])

    return (
        <div className="ur-card">
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
                <div style={{ position: "relative", flexShrink: 0 }}>
                    <img src={av} alt="" style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover", display: "block" }}
                        onError={(e: any) => { e.target.src = "https://cdn.discordapp.com/embed/avatars/0.png" }} />
                    {hasOv && (
                        <div style={{
                            position: "absolute", bottom: 0, right: 0, width: 10, height: 10,
                            borderRadius: "50%", background: "var(--brand-500)",
                            border: "2px solid var(--background-secondary)",
                        }} />
                    )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--header-primary)" }}>{name}</span>
                        {user.nick ? (
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 20, background: "rgba(88,101,242,.18)", color: "var(--brand-400)" }}>
                                {user.nick}
                            </span>
                        ) : null}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                        {user.id} · added {addedDate}
                    </div>
                </div>
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                    <UrIconAction onClick={() => setEditNick(v => !v)} title="Edit label">✏️</UrIconAction>
                    <UrIconAction onClick={() => setExpanded(v => !v)} title="Per-user overrides">
                        <span style={{ fontSize: 11 }}>{expanded ? "▲" : "▼"}</span>
                    </UrIconAction>
                    <UrIconAction onClick={onRemove} title="Stop watching" danger>🗑</UrIconAction>
                </div>
            </div>

            {editNick && (
                <div style={{ display: "flex", gap: 8, padding: "10px 14px 12px", borderTop: "1px solid var(--background-modifier-accent)", animation: "ur-in .14s ease" }}>
                    <div style={{ flex: 1 }}>
                        <TextInput value={nick} onChange={(v: string) => setNick(v)} placeholder={`Label for ${name}`}
                            onKeyDown={(e: any) => { if (e.key === "Enter") saveNick(); if (e.key === "Escape") setEditNick(false) }}
                            autoFocus />
                    </div>
                    <Button size={Button.Sizes.MEDIUM} onClick={saveNick}>Save</Button>
                    <Button size={Button.Sizes.MEDIUM} color={Button.Colors.TRANSPARENT} onClick={() => setEditNick(false)}>Cancel</Button>
                </div>
            )}

            {expanded && (
                <div style={{ borderTop: "1px solid var(--background-modifier-accent)" }}>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 14px 6px" }}>
                        Click to override global setting per-person. Right-click to reset.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: "0 12px 10px" }}>
                        {OVERRIDE_ITEMS.map(item => {
                            const isOn = featureOn(settings, user.id, item.key as any, item.gk)
                            const isOv = (ovs as any)[item.key] !== null && (ovs as any)[item.key] !== undefined
                            return (
                                <UrChip
                                    key={item.key} on={isOn} overridden={isOv}
                                    icon={item.icon} label={item.label}
                                    onClick={() => {
                                        if (!isOv) setOv(item.key, !isOn)
                                        else if ((ovs as any)[item.key] === true) setOv(item.key, false)
                                        else setOv(item.key, null)
                                    }}
                                    onRightClick={() => setOv(item.key, null)}
                                />
                            )
                        })}
                    </div>
                    <div style={{ padding: "0 12px 12px" }}>
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.TRANSPARENT}
                            onClick={() => {
                                const reset: any = {}
                                OVERRIDE_ITEMS.forEach(i => { reset[i.key] = null })
                                patchUser(settings, user.id, { overrides: reset })
                                onUpdate()
                            }}
                        >
                            ↩ Reset all overrides
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}

function UrWatchlistTab({ onUpdate }: { onUpdate: () => void }) {
    const [users, setUsers] = React.useState<WatchedUser[]>(() => {
        try { return getWatchlist(settings) } catch { return [] }
    })
    const [search, setSearch] = React.useState("")

    const refresh = () => {
        try { setUsers(getWatchlist(settings)) } catch { setUsers([]) }
        onUpdate()
    }

    const shown = search.trim()
        ? users.filter(u => {
            try {
                const du = UserStore.getUser(u.id)
                const hay = [displayName(du), u.nick ?? "", u.id].join(" ").toLowerCase()
                return hay.includes(search.toLowerCase())
            } catch { return true }
        })
        : users

    if (users.length === 0) return (
        <div style={{ textAlign: "center", padding: "44px 20px" }}>
            <div style={{ fontSize: 44, marginBottom: 12, opacity: .6 }}>👁</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--header-primary)", marginBottom: 6 }}>Nobody on the watchlist</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Go to "Add User" to start tracking someone</div>
        </div>
    )

    return (
        <>
            {users.length > 3 && (
                <div style={{ marginBottom: 12 }}>
                    <TextInput value={search} onChange={(v: string) => setSearch(v)} placeholder="Search by name, label, or ID…" />
                </div>
            )}
            {shown.length === 0
                ? <div style={{ textAlign: "center", padding: "24px 0", fontSize: 13, color: "var(--text-muted)" }}>No results for "{search}"</div>
                : shown.map(u => (
                    <UrUserCard key={u.id} user={u} onUpdate={refresh} onRemove={() => { removeUser(settings, u.id); refresh() }} />
                ))
            }
        </>
    )
}

type LookupState =
    | { stage: "idle" }
    | { stage: "loading" }
    | { stage: "found"; user: any; av: string; banner: string | null; accent: string | null }
    | { stage: "error"; msg: string }

function UrAddTab({ onAdded }: { onAdded: () => void }) {
    const [rawId, setRawId] = React.useState("")
    const [label, setLabel] = React.useState("")
    const [lk, setLk]       = React.useState<LookupState>({ stage: "idle" })

    const cleanId = rawId.trim().replace(/\D/g, "")

    const doLookup = () => {
        if (!cleanId) return setLk({ stage: "error", msg: "Paste a user ID first." })
        if (cleanId.length < 17 || cleanId.length > 20) return setLk({ stage: "error", msg: "Discord IDs are 17–20 digits." })
        if (isWatched(settings, cleanId)) return setLk({ stage: "error", msg: "Already watching this person." })
        setLk({ stage: "loading" })
        RestAPI.get({
            url: `/users/${cleanId}/profile`,
            query: { with_mutual_guilds: false, with_mutual_friends_count: false },
        }).then((res: any) => {
            const d = camelize(res.body)
            setLk({
                stage: "found",
                user: d.user,
                av: safeAvatarUrl(d.user?.id ?? cleanId, d.user?.avatar, 128),
                banner: bannerCdnUrl(d.user?.id ?? cleanId, d.user?.banner),
                accent: toHexColor(d.user?.accentColor),
            })
        }).catch((e: any) => {
            const s = e?.status ?? e?.response?.status
            setLk({
                stage: "error",
                msg: s === 404 ? "User not found." : s === 403 ? "Profile is private — you can still add by ID." : `Request failed${s ? ` (${s})` : ""}.`,
            })
        })
    }

    const doAdd = () => {
        if (lk.stage !== "found") return
        addUser(settings, cleanId, label.trim())
        setRawId(""); setLabel(""); setLk({ stage: "idle" })
        onAdded()
    }

    if (lk.stage === "found") return (
        <div style={{ animation: "ur-in .18s ease" }}>
            <div style={{ borderRadius: 10, overflow: "hidden", marginBottom: 16, border: "1px solid var(--background-modifier-accent)", boxShadow: "0 4px 20px rgba(0,0,0,.2)" }}>
                <div style={{
                    height: lk.banner ? 96 : 60, position: "relative",
                    background: lk.banner ? `url(${lk.banner}) center/cover no-repeat`
                        : lk.accent ? `linear-gradient(135deg,${lk.accent}bb,${lk.accent}44)`
                        : "linear-gradient(135deg,#5865f2,#4752c4)",
                }}>
                    <img src={lk.av} alt="" style={{ position: "absolute", bottom: -22, left: 16, width: 56, height: 56, borderRadius: "50%", border: "4px solid var(--modal-background,var(--background-primary))", objectFit: "cover" }}
                        onError={(e: any) => { e.target.src = "https://cdn.discordapp.com/embed/avatars/0.png" }} />
                </div>
                <div style={{ padding: "28px 16px 16px", background: "var(--background-secondary)" }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: "var(--header-primary)" }}>{lk.user?.globalName || lk.user?.username || cleanId}</div>
                    {lk.user?.globalName && <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>@{lk.user.username}</div>}
                    {lk.user?.bio && <div style={{ fontSize: 13, color: "var(--text-normal)", marginTop: 8, lineHeight: 1.4, opacity: .85, overflow: "hidden", maxHeight: "2.8em" }}>{lk.user.bio}</div>}
                </div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--header-secondary)", marginBottom: 6 }}>
                Label <span style={{ fontWeight: 400, textTransform: "none", color: "var(--text-muted)" }}>— optional</span>
            </div>
            <TextInput value={label} onChange={(v: string) => setLabel(v)} placeholder={'e.g. "bestie", "coworker"'}
                onKeyDown={(e: any) => { if (e.key === "Enter") doAdd() }} autoFocus />
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 5, marginBottom: 16 }}>Only visible in your notifications</div>
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={doAdd} size={Button.Sizes.MEDIUM} style={{ flex: 1 }}>Add to Watchlist</Button>
                <Button onClick={() => { setLk({ stage: "idle" }); setLabel("") }} size={Button.Sizes.MEDIUM} color={Button.Colors.TRANSPARENT}>Cancel</Button>
            </div>
        </div>
    )

    return (
        <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--header-secondary)", marginBottom: 6 }}>User ID</div>
            <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <TextInput value={rawId} onChange={(v: string) => { setRawId(v); if (lk.stage === "error") setLk({ stage: "idle" }) }}
                        placeholder="e.g. 123456789012345678" onKeyDown={(e: any) => { if (e.key === "Enter") doLookup() }} autoFocus />
                </div>
                <Button onClick={doLookup} size={Button.Sizes.MEDIUM} disabled={lk.stage === "loading" || !rawId.trim()} style={{ flexShrink: 0 }}>
                    {lk.stage === "loading" ? <><span className="ur-spinner" style={{ marginRight: 6 }} />Looking up…</> : "Look Up"}
                </Button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                Enable <strong style={{ color: "var(--text-normal)" }}>Developer Mode</strong> in Discord settings → right-click any user → Copy User ID
            </div>
            {lk.stage === "error" && (
                <div style={{ display: "flex", gap: 9, alignItems: "flex-start", marginTop: 12, padding: "10px 13px", borderRadius: 8, background: "rgba(237,66,69,.08)", border: "1px solid rgba(237,66,69,.3)", animation: "ur-in .14s ease" }}>
                    <span style={{ fontSize: 15, flexShrink: 0 }}>⚠️</span>
                    <span style={{ fontSize: 13, color: "var(--status-danger)" }}>{lk.msg}</span>
                </div>
            )}
        </div>
    )
}

// Need Button and TextInput from common — grab them here
const { Button, TextInput } = (await import("@webpack/common")) as any

function WatchlistModal({ modalProps }: { modalProps: any }) {
    React.useEffect(() => { injectModalStyles() }, [])
    const [tab,   setTab]   = React.useState<"list" | "add">("list")
    const [count, setCount] = React.useState(() => { try { return getWatchlist(settings).length } catch { return 0 } })
    const refreshCount = () => { try { setCount(getWatchlist(settings).length) } catch { setCount(0) } }

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
                    <span style={{ fontSize: 20 }}>👁</span>
                    <span style={{ fontSize: 17, fontWeight: 700, color: "var(--header-primary)" }}>UserRadar</span>
                    {count > 0 && (
                        <span style={{ background: "var(--brand-500)", color: "#fff", borderRadius: 10, fontSize: 11, fontWeight: 700, padding: "1px 7px" }}>
                            {count}
                        </span>
                    )}
                </div>
            </ModalHeader>
            <ModalContent style={{ padding: "4px 16px 24px" }}>
                <div style={{ display: "flex", gap: 2, padding: 3, background: "var(--background-secondary)", borderRadius: 10, marginBottom: 16 }}>
                    <UrTab active={tab === "list"} onClick={() => setTab("list")}>
                        Watchlist{count > 0 ? ` (${count})` : ""}
                    </UrTab>
                    <UrTab active={tab === "add"} onClick={() => setTab("add")}>+ Add User</UrTab>
                </div>
                {tab === "list" && <UrWatchlistTab onUpdate={refreshCount} />}
                {tab === "add"  && <UrAddTab onAdded={() => { refreshCount(); setTab("list") }} />}
            </ModalContent>
        </ModalRoot>
    )
}

// ============================================================
// PLUGIN
// ============================================================

export default definePlugin({
    name: "UserRadar",
    description: "Watch specific users and get notified about their messages, edits, deletes, typing, voice activity, profile changes, and more.",
    authors: [{ id: 641266820187160576, name: "k1ng_op" }],

    settings,

    settingsAboutComponent() {
        return (
            <div>
                <Text variant="heading-sm/semibold" style={{ marginBottom: 8 }}>Watchlist</Text>
                <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
                    Manage the users you're tracking below. You can also right-click any user → "Watch User" to add them on the fly.
                </Text>
                <button
                    style={{ background: "var(--brand-500)", color: "#fff", border: "none", borderRadius: 4, padding: "8px 14px", cursor: "pointer", fontWeight: 600, fontSize: 14, width: "100%" }}
                    onClick={() => openModal(p => <WatchlistModal modalProps={p} />)}
                >
                    Open Watchlist Manager
                </button>
            </div>
        )
    },

    flux: {
        MESSAGE_CREATE(evt: MsgCreateEvent) {
            const { message, guildId, channelId } = evt
            if (!message?.author?.id) return
            if (!featureOn(settings, message.author.id, "msgs", "globalMsgs")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === channelId) return
            const u = UserStore.getUser(message.author.id)
            const name = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            if (message.type === 7) {
                push({ title: `${label ? `${label} (${name})` : name} joined a server`, body: "Click to view", icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, channelId, message.id) })
                return
            }
            push({ title: `${label ? `${label} (${name})` : name} sent a message`, body: msgPreview(message.content, message.attachments?.[0]?.filename), icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, channelId, message.id) })
        },

        MESSAGE_UPDATE(evt: MsgUpdateEvent) {
            const { message, guildId } = evt
            if (!message?.author?.id) return
            if (!featureOn(settings, message.author.id, "edits", "globalEdits")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === message.channel_id) return
            const u = UserStore.getUser(message.author.id)
            const name = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            push({ title: `${label ? `${label} (${name})` : name} edited a message`, body: msgPreview(message.content, message.attachments?.[0]?.filename), icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, message.channel_id, message.id) })
        },

        async MESSAGE_DELETE(evt: MsgDeleteEvent) {
            if (!evt?.channelId || !evt?.id) return
            let msg: Message | undefined = MessageStore.getMessage(evt.channelId, evt.id)
            if (!msg) { const store = await tryLoadLoggedMsgs(); msg = store?.[evt.id] as Message | undefined }
            if (!msg?.author?.id) return
            if (!featureOn(settings, msg.author.id, "deletes", "globalDeletes")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === msg.channel_id) return
            const u = UserStore.getUser(msg.author.id)
            const name = displayName(u ?? msg.author)
            const label = getWatchedUser(settings, msg.author.id)?.nick
            const body = settings.store.showPreview && msg.content ? `"${truncate(msg.content, settings.store.previewLen)}"` : "Message was deleted"
            push({ title: `${label ? `${label} (${name})` : name} deleted a message`, body, icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(evt.guildId, msg!.channel_id, msg!.id) })
        },

        TYPING_START(evt: TypingEvent) {
            if (!evt?.userId || !evt?.channelId) return
            if (!featureOn(settings, evt.userId, "typing", "globalTyping")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === evt.channelId) return
            const u = UserStore.getUser(evt.userId)
            if (!u) return
            const name = displayName(u)
            const label = getWatchedUser(settings, evt.userId)?.nick
            const ch = ChannelStore.getChannel(evt.channelId)
            push({ title: `${label ? `${label} (${name})` : name} is typing…`, body: ch?.name ? `In #${ch.name}` : "Click to jump", icon: u.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(ch?.guild_id, evt.channelId) })
        },

        USER_UPDATE(evt: { user: any }) {
            if (!evt?.user?.id) return
            const uid = evt.user.id
            if (!isWatched(settings, uid)) return
            if (!featureOn(settings, uid, "profile", "globalProfile")) return
            const old = profileCache[uid]
            if (!old) return
            const fresh = { ...old, user: { ...old.user, ...camelize(evt.user) } }
            checkProfileChanged(uid, fresh as ProfileFetchEvent)
        },

        async USER_PROFILE_FETCH_SUCCESS(rawEvt: ProfileFetchEvent) {
            if (!rawEvt?.user?.id) return
            checkProfileChanged(rawEvt.user.id, camelize(rawEvt) as ProfileFetchEvent)
        },

        VOICE_STATE_UPDATES(evt: VoiceStateEvent) {
            if (!settings.store.globalVoice) return
            for (const state of evt.voiceStates ?? []) {
                const { userId, channelId, guildId } = state
                if (!featureOn(settings, userId, "voice", "globalVoice")) continue
                const prev = vcCache[userId] ?? null
                vcCache[userId] = channelId ?? null
                if (prev === (channelId ?? null)) continue
                const u = UserStore.getUser(userId)
                const name = displayName(u)
                const label = getWatchedUser(settings, userId)?.nick
                const dname = label ? `${label} (${name})` : name
                const icon = u?.getAvatarURL(undefined, undefined, false)
                if (!prev && channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    push({ title: `${dname} joined voice`, body: ch ? `#${ch.name}` : "Click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                } else if (prev && !channelId) {
                    push({ title: `${dname} left voice`, body: "They disconnected", icon, onClick: () => openUserProfile(userId) })
                } else if (prev && channelId && prev !== channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    push({ title: `${dname} moved voice channels`, body: ch ? `Now in #${ch.name}` : "Click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                }
            }
        },

        PRESENCE_UPDATES(evt: PresenceEvent) {
            if (!settings.store.globalStatus) return
            for (const update of evt.updates ?? []) {
                const { id } = update.user
                if (!featureOn(settings, id, "status", "globalStatus")) continue
                const prev = statusCache[id]
                statusCache[id] = update.status
                if (!prev || prev === update.status) continue
                const u = UserStore.getUser(id)
                const name = displayName(u)
                const label = getWatchedUser(settings, id)?.nick
                push({ title: `${label ? `${label} (${name})` : name} is now ${update.status} ${STATUS_EMOJI[update.status] ?? ""}`, body: `Was: ${prev} ${STATUS_EMOJI[prev] ?? ""}`, icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => openUserProfile(id) })
            }
        },
    },

    async start() {
        addContextMenuPatch("user-context", userContextPatch)
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
            Notification.requestPermission().then(p => { log.info("notification permission:", p) })
        }
        for (const wu of getWatchlist(settings)) {
            try {
                const { body } = await RestAPI.get({ url: `/users/${wu.id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } })
                profileCache[wu.id] = camelize(body)
            } catch { log.warn(`couldn't pre-fetch profile for ${wu.id}`) }
        }
        pollTimer = setInterval(pollProfiles, POLL_INTERVAL)
        tryLoadLoggedMsgs().then(m => {
            if (m) log.info("hooked into message logger store")
            else log.warn("message logger not found")
        })
    },

    stop() {
        removeContextMenuPatch("user-context", userContextPatch)
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        for (const k in profileCache) delete profileCache[k]
        for (const k in vcCache) delete vcCache[k]
        for (const k in statusCache) delete statusCache[k]
        loggedMsgs = null
    },

    async watchUser(id: string) {
        const u = UserStore.getUser(id)
        addUser(settings, id)
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `Now watching ${displayName(u)}`, id: Toasts.genId() })
        try {
            const { body } = await RestAPI.get({ url: `/users/${id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } })
            profileCache[id] = camelize(body)
        } catch { }
    },

    unwatchUser(id: string) {
        const u = UserStore.getUser(id)
        removeUser(settings, id)
        delete profileCache[id]; delete vcCache[id]; delete statusCache[id]
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `Stopped watching ${displayName(u)}`, id: Toasts.genId() })
    },
})

// ---------- context menu ----------

const userContextPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.user || props.user.id === UserStore.getCurrentUser()?.id) return
    const { id } = props.user
    const watching = isWatched(settings, id)
    if (children.some((c: any) => c?.props?.id === "userradar-group")) return
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuGroup id="userradar-group">
            <Menu.MenuItem
                id="userradar-toggle"
                label={watching ? "👁 Stop Watching User" : "👁 Watch User"}
                action={() => {
                    const plugin = Vencord.Plugins.plugins["UserRadar"] as any
                    watching ? plugin.unwatchUser(id) : plugin.watchUser(id)
                }}
            />
            {watching && (
                <Menu.MenuItem
                    id="userradar-manage"
                    label="⚙ Manage Watchlist"
                    action={() => openModal(p => <WatchlistModal modalProps={p} />)}
                />
            )}
        </Menu.MenuGroup>
    )
}
