/*
 * UserRadar - a Vencord plugin by Mubashir
 * Tracks specific users and fires notifications for messages, edits,
 * deletes, typing, profile changes, voice activity, and status changes.
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu"
import { Notifications } from "@api/index"
import { definePluginSettings } from "@api/Settings"
import { getCurrentChannel, openUserProfile } from "@utils/discord"
import { openModal, ModalRoot, ModalHeader, ModalContent, ModalSize } from "@utils/modal"
import definePlugin, { OptionType } from "@utils/types"
import { findByProps } from "@webpack"
import { Button, ChannelStore, Menu, MessageStore, React, RestAPI, Text, TextInput, Toasts, UserStore } from "@webpack/common"
import { Message } from "discord-types/general"

import {
    addUser, camelize, displayName, featureOn,
    getWatchedUser, getWatchlist, inQuietHours,
    isWatched, log, patchUser, removeUser, STATUS_EMOJI
} from "./store"

import {
    MsgCreateEvent, MsgDeleteEvent, MsgUpdateEvent,
    PresenceEvent, ProfileFetchEvent,
    TypingEvent, VoiceStateEvent, WatchedUser
} from "./types"

// ── runtime caches ───────────────────────────────────────────────────────────

const profileCache: Record<string, any> = {}
const vcCache: Record<string, string | null> = {}
const statusCache: Record<string, string> = {}
let loggedMsgs: Record<string, Message> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

// ── logger plugin hook ───────────────────────────────────────────────────────

async function tryLoadLoggedMsgs() {
    if (loggedMsgs) return loggedMsgs
    for (const prefix of ["plugins", "userplugins"]) {
        try {
            // @ts-ignore
            const m = await import(`${prefix}/vc-message-logger-enhanced/LoggedMessageManager`)
            loggedMsgs = m.loggedMessages ?? null
            return loggedMsgs
        } catch { }
    }
    return null
}

// ── settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    watchlist:          { type: OptionType.STRING,  default: "[]",     description: "Watched users (JSON)",                                              hidden: true },
    globalMsgs:         { type: OptionType.BOOLEAN, default: true,     description: "Notify on new messages" },
    globalEdits:        { type: OptionType.BOOLEAN, default: true,     description: "Notify on message edits" },
    globalDeletes:      { type: OptionType.BOOLEAN, default: true,     description: "Notify on message deletes (needs vc-message-logger-enhanced)" },
    globalTyping:       { type: OptionType.BOOLEAN, default: true,     description: "Notify when someone starts typing" },
    globalProfile:      { type: OptionType.BOOLEAN, default: true,     description: "Notify on profile changes" },
    globalVoice:        { type: OptionType.BOOLEAN, default: true,     description: "Notify on voice joins / leaves" },
    globalStatus:       { type: OptionType.BOOLEAN, default: false,    description: "Notify on status changes (noisy, off by default)" },
    showPreview:        { type: OptionType.BOOLEAN, default: true,     description: "Show message content in notifications" },
    previewLen:         { type: OptionType.NUMBER,  default: 120,      description: "Max chars in message preview (0 = no limit)" },
    quietHours:         { type: OptionType.BOOLEAN, default: false,    description: "Mute notifications during a time window" },
    quietStart:         { type: OptionType.STRING,  default: "23:00",  description: "Quiet hours start (24h)" },
    quietEnd:           { type: OptionType.STRING,  default: "07:00",  description: "Quiet hours end (24h)" },
    skipCurrentChannel: { type: OptionType.BOOLEAN, default: true,     description: "Don't notify if you're already in that channel" },
    debugLog:           { type: OptionType.BOOLEAN, default: false,    description: "Log all tracked events to console" },
})

// ── notification push ────────────────────────────────────────────────────────

function trunc(s: string, max: number) { return max > 0 && s.length > max ? s.slice(0, max) + "…" : s }
function preview(content: string, file?: string) {
    if (!settings.store.showPreview) return "Click to jump"
    return trunc(content || file || "Click to jump", settings.store.previewLen)
}
function jumpTo(guildId?: string, channelId?: string, msgId?: string) {
    if (guildId)   findByProps("transitionToGuildSync")?.transitionToGuildSync(guildId)
    if (channelId) findByProps("selectChannel")?.selectChannel({ guildId: guildId ?? "@me", channelId, messageId: msgId })
}
function push(opts: { title: string; body: string; icon?: string; onClick?: () => void }) {
    if (inQuietHours(settings)) return
    if (settings.store.debugLog) log.info(`notif: ${opts.title} — ${opts.body}`)
    const show = () => Notifications.showNotification({ title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick })
    if (document.hasFocus()) { show(); return }
    try {
        const n = new window.Notification(opts.title, { body: opts.body, icon: opts.icon })
        if (opts.onClick) n.onclick = () => { window.focus(); opts.onClick!() }
    } catch { show() }
}

// ── profile diffing ──────────────────────────────────────────────────────────

const PFIELDS = ["username", "globalName", "avatar", "bio", "banner", "bannerColor", "accentColor"] as const
const PLABELS: Record<string, string> = { username: "username", globalName: "display name", avatar: "avatar", bio: "bio", banner: "banner", bannerColor: "banner color", accentColor: "accent color" }

function checkProfile(uid: string, fresh: any) {
    if (!isWatched(settings, uid) || !featureOn(settings, uid, "profile", "globalProfile")) return
    const old = profileCache[uid]
    if (!old) { profileCache[uid] = fresh; return }
    const changed = PFIELDS.filter(f => fresh.user?.[f] !== old.user?.[f])
    if (!changed.length) return
    const u = UserStore.getUser(uid)
    const name = displayName(fresh.user)
    const label = getWatchedUser(settings, uid)?.nick
    push({ title: `${label ? `${label} (${name})` : name} updated their profile`, body: `Changed: ${changed.map(f => PLABELS[f]).join(", ")}`, icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => openUserProfile(uid) })
    profileCache[uid] = fresh
}

async function pollProfiles() {
    const list = getWatchlist(settings)
    if (!list.length) return
    for (const wu of list) {
        try {
            const { body } = await RestAPI.get({ url: `/users/${wu.id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } })
            checkProfile(wu.id, camelize(body))
        } catch { }
        await new Promise(r => setTimeout(r, 1500))
    }
}

// ── modal helpers ────────────────────────────────────────────────────────────

function safeAvatar(id: string, hash?: string | null, size = 80) {
    try {
        if (hash) return `https://cdn.discordapp.com/avatars/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=${size}`
        let idx = 0
        try { idx = Number(BigInt(id) % BigInt(6)) } catch { idx = parseInt(id.slice(-1), 10) % 6 || 0 }
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`
    } catch { return "https://cdn.discordapp.com/embed/avatars/0.png" }
}
function duAvatar(du: any, id: string, size = 64) {
    try { return safeAvatar(du?.id ?? id, du?.avatar, size) } catch { return safeAvatar(id, null, size) }
}
function bannerUrl(id: string, hash?: string | null) {
    if (!hash) return null
    try { return `https://cdn.discordapp.com/banners/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=480` } catch { return null }
}
function hexColor(n?: number | null) {
    if (n == null) return null
    try { return "#" + n.toString(16).padStart(6, "0") } catch { return null }
}

const FALLBACK_AV = "https://cdn.discordapp.com/embed/avatars/0.png"

// inject CSS once, only in useEffect (never during render)
// ── styles ────────────────────────────────────────────────────────────────────

const STYLE_ID = "ur-s7"
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement("style")
    s.id = STYLE_ID
    s.textContent = `
        @keyframes ur-in  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
        @keyframes ur-spin { to{transform:rotate(360deg)} }

        .ur-card {
            border-radius:14px; overflow:hidden; margin-bottom:6px;
            border:1px solid var(--background-modifier-accent);
            background:var(--background-secondary-alt,var(--background-secondary));
            transition:border-color .18s, box-shadow .18s, transform .12s;
            animation:ur-in .16s ease;
        }
        .ur-card:hover {
            border-color:rgba(88,101,242,.5);
            box-shadow:0 4px 24px rgba(0,0,0,.22);
            transform:translateY(-1px);
        }
        .ur-row { display:flex; align-items:center; gap:13px; padding:11px 13px; }
        .ur-av  { width:46px; height:46px; border-radius:50%; object-fit:cover; display:block; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,.3); }
        .ur-av-wrap { position:relative; flex-shrink:0; }
        .ur-av-dot {
            position:absolute; bottom:0; right:0; width:11px; height:11px;
            border-radius:50%; background:var(--brand-500);
            border:2px solid var(--background-secondary);
        }
        .ur-name { font-weight:700; font-size:14px; color:var(--header-primary); line-height:1.2; }
        .ur-sub  { font-size:11px; color:var(--text-muted); margin-top:2px; }
        .ur-nick-pill {
            display:inline-block; font-size:10px; font-weight:700;
            padding:2px 8px; border-radius:20px;
            background:rgba(88,101,242,.2); color:var(--brand-400); margin-left:5px;
        }
        .ur-actions { display:flex; gap:2px; flex-shrink:0; margin-left:auto; }
        .ur-ibtn {
            display:inline-flex; align-items:center; justify-content:center;
            width:30px; height:30px; border-radius:8px; cursor:pointer; font-size:14px;
            transition:background .12s, color .12s, transform .1s;
            color:var(--interactive-normal); background:transparent; user-select:none;
        }
        .ur-ibtn:hover { background:var(--background-modifier-hover); color:var(--interactive-hover); transform:scale(1.1); }
        .ur-ibtn.d:hover { background:rgba(237,66,69,.15); color:var(--status-danger); }
        .ur-chips { display:grid; grid-template-columns:1fr 1fr; gap:5px; padding:4px 12px 12px; }
        .ur-chip {
            display:flex; align-items:center; gap:7px; padding:7px 10px; border-radius:9px;
            border:1.5px solid var(--background-modifier-accent);
            background:var(--background-tertiary); cursor:pointer; user-select:none;
            transition:all .14s; opacity:.65;
        }
        .ur-chip.on { border-color:rgba(88,101,242,.5); background:rgba(88,101,242,.12); opacity:1; }
        .ur-chip-lbl { flex:1; font-size:12px; font-weight:500; color:var(--text-muted); }
        .ur-chip.on .ur-chip-lbl { color:var(--text-normal); }
        .ur-tgl {
            position:relative; width:30px; height:17px; border-radius:9px; flex-shrink:0;
            background:var(--background-modifier-accent); transition:background .14s;
        }
        .ur-tgl.on { background:var(--brand-500); }
        .ur-tgl-thumb {
            position:absolute; top:2px; left:2px; width:13px; height:13px;
            border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.3);
            transition:left .14s;
        }
        .ur-tgl.on .ur-tgl-thumb { left:15px; }
        .ur-spin {
            display:inline-block; width:12px; height:12px; border-radius:50%;
            border:2px solid rgba(255,255,255,.3); border-top-color:#fff;
            animation:ur-spin .6s linear infinite; vertical-align:middle;
        }
        .ur-err {
            display:flex; gap:10px; align-items:flex-start; margin-top:12px;
            padding:10px 13px; border-radius:10px;
            background:rgba(237,66,69,.08); border:1px solid rgba(237,66,69,.3);
        }
    `
    document.head.appendChild(s)
}

// ── primitive components ──────────────────────────────────────────────────────

function Btn({ onClick, style, title, ch }: { onClick: () => void; style?: any; title?: string; ch: any }) {
    return <div role="button" tabIndex={0} title={title} onClick={onClick}
        onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
        style={{ cursor: "pointer", userSelect: "none", ...style }}>{ch}</div>
}

function IBtn({ onClick, title, danger, ch }: { onClick: () => void; title?: string; danger?: boolean; ch: any }) {
    return <div role="button" tabIndex={0} title={title} onClick={onClick}
        onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
        className={`ur-ibtn${danger ? " d" : ""}`}>{ch}</div>
}

function Tgl({ on, toggle }: { on: boolean; toggle: () => void }) {
    return <Btn onClick={toggle} ch={
        <div className={`ur-tgl${on ? " on" : ""}`}><div className="ur-tgl-thumb" /></div>
    } />
}

function TabBtn({ active, onClick, ch }: { active: boolean; onClick: () => void; ch: any }) {
    return <Btn onClick={onClick} ch={ch} style={{
        flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 9, fontSize: 13,
        fontWeight: active ? 700 : 500,
        color: active ? "var(--header-primary)" : "var(--text-muted)",
        background: active ? "var(--background-primary)" : "transparent",
        boxShadow: active ? "0 1px 5px rgba(0,0,0,.25)" : "none",
        transition: "background .12s, color .12s",
    }} />
}

// ── override chips ────────────────────────────────────────────────────────────

const OV_ITEMS = [
    { label: "Messages", icon: "💬", key: "msgs",    gk: "globalMsgs"    },
    { label: "Edits",    icon: "✏️",  key: "edits",   gk: "globalEdits"   },
    { label: "Deletes",  icon: "🗑",  key: "deletes", gk: "globalDeletes" },
    { label: "Typing",   icon: "⌨️",  key: "typing",  gk: "globalTyping"  },
    { label: "Profile",  icon: "🪪",  key: "profile", gk: "globalProfile" },
    { label: "Voice",    icon: "🎙",  key: "voice",   gk: "globalVoice"   },
    { label: "Status",   icon: "🟢",  key: "status",  gk: "globalStatus"  },
] as const

function Chip({ on, overridden, icon, label, onClick, onRight }: {
    on: boolean; overridden: boolean; icon: string; label: string; onClick: () => void; onRight: () => void
}) {
    return (
        <div className={`ur-chip${on ? " on" : ""}`} role="button" tabIndex={0}
            onClick={onClick}
            onContextMenu={(e: any) => { e.preventDefault(); onRight() }}
            onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
            title={overridden ? "Overriding global — right-click to reset" : "Click to override global"}
        >
            <span style={{ fontSize: 13 }}>{icon}</span>
            <span className="ur-chip-lbl">{label}</span>
            {overridden && <span style={{ fontSize: 7, color: "var(--brand-400)" }}>●</span>}
            <Tgl on={on} toggle={onClick} />
        </div>
    )
}

// ── UserCard ──────────────────────────────────────────────────────────────────

function UserCard({ user, refresh, remove }: { user: WatchedUser; refresh: () => void; remove: () => void }) {
    const [nick,     setNick] = React.useState(user.nick ?? "")
    const [expanded, setExp]  = React.useState(false)
    const [editNick, setEdit] = React.useState(false)

    const du      = React.useMemo(() => { try { return UserStore.getUser(user.id) ?? null } catch { return null } }, [user.id])
    const av      = duAvatar(du, user.id)
    const name    = (du ? displayName(du) : null) || user.nick || user.id
    const ovs     = user.overrides ?? {} as any
    const hasOv   = Object.values(ovs).some((v: any) => v !== null && v !== undefined)
    const addedDate = React.useMemo(() => { try { return new Date(user.addedAt).toLocaleDateString() } catch { return "—" } }, [user.addedAt])

    const saveNick = () => { patchUser(settings, user.id, { nick: nick.trim() }); setEdit(false); refresh() }
    const setOv    = (key: string, val: boolean | null) => { patchUser(settings, user.id, { overrides: { ...ovs, [key]: val } as any }); refresh() }

    return (
        <div className="ur-card">
            {/* main row */}
            <div className="ur-row">
                <div className="ur-av-wrap">
                    <img className="ur-av" src={av} alt="" onError={(e: any) => { e.target.src = FALLBACK_AV }} />
                    {hasOv && <div className="ur-av-dot" />}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ur-name">
                        {name}
                        {user.nick ? <span className="ur-nick-pill">{user.nick}</span> : null}
                    </div>
                    <div className="ur-sub">{user.id} · {addedDate}</div>
                </div>

                <div className="ur-actions">
                    <IBtn onClick={() => setEdit(v => !v)} title="Edit label" ch="✏️" />
                    <IBtn onClick={() => setExp(v => !v)} title="Per-user overrides" ch={
                        <span style={{ fontSize: 10, fontWeight: 700 }}>{expanded ? "▲" : "▼"}</span>
                    } />
                    <IBtn onClick={remove} title="Stop watching" danger ch="🗑" />
                </div>
            </div>

            {/* label editor */}
            {editNick && (
                <div style={{ display: "flex", gap: 8, padding: "8px 12px 12px", borderTop: "1px solid var(--background-modifier-accent)", background: "var(--background-tertiary)" }}>
                    <div style={{ flex: 1 }}>
                        <TextInput value={nick} onChange={(v: string) => setNick(v)}
                            placeholder={`Nickname for ${name}`}
                            onKeyDown={(e: any) => { if (e.key === "Enter") saveNick(); if (e.key === "Escape") setEdit(false) }}
                            autoFocus />
                    </div>
                    <Button size={Button.Sizes.MEDIUM} onClick={saveNick}>Save</Button>
                    <Button size={Button.Sizes.MEDIUM} color={Button.Colors.TRANSPARENT} onClick={() => setEdit(false)}>Cancel</Button>
                </div>
            )}

            {/* overrides panel */}
            {expanded && (
                <div style={{ borderTop: "1px solid var(--background-modifier-accent)" }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "8px 13px 3px" }}>
                        Per-user overrides · right-click any chip to reset it
                    </div>
                    <div className="ur-chips">
                        {OV_ITEMS.map(item => {
                            const isOn = featureOn(settings, user.id, item.key as any, item.gk)
                            const isOv = ovs[item.key] !== null && ovs[item.key] !== undefined
                            return <Chip key={item.key} on={isOn} overridden={isOv} icon={item.icon} label={item.label}
                                onClick={() => { if (!isOv) setOv(item.key, !isOn); else if (ovs[item.key] === true) setOv(item.key, false); else setOv(item.key, null) }}
                                onRight={() => setOv(item.key, null)} />
                        })}
                    </div>
                    <div style={{ padding: "0 12px 12px" }}>
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.TRANSPARENT}
                            onClick={() => { const r: any = {}; OV_ITEMS.forEach(i => { r[i.key] = null }); patchUser(settings, user.id, { overrides: r }); refresh() }}>
                            ↩ Reset all to global
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}

// ── WatchlistTab ──────────────────────────────────────────────────────────────

function WatchlistTab({ onUpdate }: { onUpdate: () => void }) {
    const [users, setUsers] = React.useState<WatchedUser[]>(() => { try { return getWatchlist(settings) } catch { return [] } })
    const [search, setSearch] = React.useState("")
    const refresh = () => { try { setUsers(getWatchlist(settings)) } catch { setUsers([]) }; onUpdate() }
    const shown = search.trim()
        ? users.filter(u => { try { return [displayName(UserStore.getUser(u.id)), u.nick ?? "", u.id].join(" ").toLowerCase().includes(search.toLowerCase()) } catch { return true } })
        : users

    if (!users.length) return (
        <div style={{ textAlign: "center", padding: "52px 20px" }}>
            <div style={{ fontSize: 52, marginBottom: 14, opacity: .4 }}>👁</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--header-primary)", marginBottom: 6 }}>Nothing here yet</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Hit "+ Add User" to start tracking someone</div>
        </div>
    )

    return <>
        {users.length > 3 && (
            <div style={{ marginBottom: 10 }}>
                <TextInput value={search} onChange={(v: string) => setSearch(v)} placeholder="Search by name, label, or ID…" />
            </div>
        )}
        {shown.length === 0
            ? <div style={{ textAlign: "center", padding: "24px 0", fontSize: 13, color: "var(--text-muted)" }}>No results for "{search}"</div>
            : shown.map(u => <UserCard key={u.id} user={u} refresh={refresh} remove={() => { removeUser(settings, u.id); refresh() }} />)
        }
    </>
}

// ── AddTab ────────────────────────────────────────────────────────────────────

type LK = { stage: "idle" } | { stage: "loading" } | { stage: "found"; user: any; av: string; banner: string | null; accent: string | null } | { stage: "error"; msg: string }

function AddTab({ onAdded }: { onAdded: () => void }) {
    const [rawId, setRawId] = React.useState("")
    const [label, setLabel] = React.useState("")
    const [lk, setLk] = React.useState<LK>({ stage: "idle" })
    const cleanId = rawId.trim().replace(/\D/g, "")

    const doLookup = () => {
        if (!cleanId) return setLk({ stage: "error", msg: "Paste a user ID first." })
        if (cleanId.length < 17 || cleanId.length > 20) return setLk({ stage: "error", msg: "Discord IDs are 17–20 digits." })
        if (isWatched(settings, cleanId)) return setLk({ stage: "error", msg: "Already watching this person." })
        setLk({ stage: "loading" })
        RestAPI.get({ url: `/users/${cleanId}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } })
            .then((res: any) => {
                const d = camelize(res.body)
                setLk({ stage: "found", user: d.user, av: safeAvatar(d.user?.id ?? cleanId, d.user?.avatar, 128), banner: bannerUrl(d.user?.id ?? cleanId, d.user?.banner), accent: hexColor(d.user?.accentColor) })
            })
            .catch((e: any) => {
                const s = e?.status ?? e?.response?.status
                setLk({ stage: "error", msg: s === 404 ? "User not found." : s === 403 ? "Profile is private — you can still add by ID." : `Request failed${s ? ` (${s})` : ""}.` })
            })
    }

    const doAdd = () => {
        if (lk.stage !== "found") return
        addUser(settings, cleanId, label.trim())
        setRawId(""); setLabel(""); setLk({ stage: "idle" })
        onAdded()
    }

    if (lk.stage === "found") return (
        <div>
            <div style={{ borderRadius: 12, overflow: "hidden", marginBottom: 16, border: "1px solid var(--background-modifier-accent)" }}>
                <div style={{ height: lk.banner ? 96 : 64, background: lk.banner ? `url(${lk.banner}) center/cover no-repeat` : lk.accent ? `linear-gradient(135deg,${lk.accent}bb,${lk.accent}44)` : "linear-gradient(135deg,#5865f2,#4752c4)", position: "relative" }}>
                    <img src={lk.av} alt="" style={{ position: "absolute", bottom: -24, left: 16, width: 58, height: 58, borderRadius: "50%", border: "4px solid var(--modal-background,var(--background-primary))", objectFit: "cover", boxShadow: "0 2px 12px rgba(0,0,0,.4)" }}
                        onError={(e: any) => { e.target.src = FALLBACK_AV }} />
                </div>
                <div style={{ padding: "30px 16px 14px", background: "var(--background-secondary)" }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "var(--header-primary)" }}>{lk.user?.globalName || lk.user?.username || cleanId}</div>
                    {lk.user?.globalName && <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>@{lk.user.username}</div>}
                    {lk.user?.bio && <div style={{ fontSize: 13, color: "var(--text-normal)", marginTop: 8, lineHeight: 1.45, opacity: .8, overflow: "hidden", maxHeight: "2.9em" }}>{lk.user.bio}</div>}
                </div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--header-secondary)", marginBottom: 6 }}>
                Label <span style={{ fontWeight: 400, textTransform: "none", color: "var(--text-muted)" }}>— optional</span>
            </div>
            <TextInput value={label} onChange={(v: string) => setLabel(v)} placeholder={'e.g. "bestie", "coworker"'}
                onKeyDown={(e: any) => { if (e.key === "Enter") doAdd() }} autoFocus />
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 5, marginBottom: 16 }}>Only visible to you in notifications</div>
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={doAdd} size={Button.Sizes.MEDIUM} style={{ flex: 1 }}>Add to Watchlist</Button>
                <Button onClick={() => { setLk({ stage: "idle" }); setLabel("") }} size={Button.Sizes.MEDIUM} color={Button.Colors.TRANSPARENT}>Cancel</Button>
            </div>
        </div>
    )

    return (
        <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--header-secondary)", marginBottom: 6 }}>User ID</div>
            <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <TextInput value={rawId} onChange={(v: string) => { setRawId(v); if (lk.stage === "error") setLk({ stage: "idle" }) }}
                        placeholder="e.g. 123456789012345678"
                        onKeyDown={(e: any) => { if (e.key === "Enter") doLookup() }} autoFocus />
                </div>
                <Button onClick={doLookup} size={Button.Sizes.MEDIUM} disabled={lk.stage === "loading" || !rawId.trim()} style={{ flexShrink: 0 }}>
                    {lk.stage === "loading" ? <><span className="ur-spin" style={{ marginRight: 6 }} />Looking up…</> : "Look Up"}
                </Button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                Enable <strong style={{ color: "var(--text-normal)" }}>Developer Mode</strong> in Discord settings → right-click any user → Copy User ID
            </div>
            {lk.stage === "error" && (
                <div className="ur-err">
                    <span style={{ flexShrink: 0 }}>⚠️</span>
                    <span style={{ fontSize: 13, color: "var(--status-danger)" }}>{lk.msg}</span>
                </div>
            )}
        </div>
    )
}

// ── WatchlistModal ────────────────────────────────────────────────────────────

function WatchlistModal({ modalProps }: { modalProps: any }) {
    React.useEffect(() => { injectStyles() }, [])
    const [tab,   setTab]   = React.useState<"list" | "add">("list")
    const [count, setCount] = React.useState(() => { try { return getWatchlist(settings).length } catch { return 0 } })
    const refreshCount = () => { try { setCount(getWatchlist(settings).length) } catch { setCount(0) } }

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "2px 0" }}>
                    <div style={{ width: 32, height: 32, borderRadius: 10, background: "linear-gradient(135deg,#5865f2,#4752c4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>👁</div>
                    <span style={{ fontSize: 17, fontWeight: 800, color: "var(--header-primary)" }}>UserRadar</span>
                    {count > 0 && (
                        <span style={{ background: "var(--brand-500)", color: "#fff", borderRadius: 12, fontSize: 11, fontWeight: 800, padding: "2px 8px", letterSpacing: ".02em" }}>
                            {count}
                        </span>
                    )}
                </div>
            </ModalHeader>
            <ModalContent style={{ padding: "2px 14px 24px" }}>
                <div style={{ display: "flex", gap: 3, padding: 4, background: "var(--background-secondary)", borderRadius: 12, marginBottom: 14 }}>
                    <TabBtn active={tab === "list"} onClick={() => setTab("list")} ch={`Watchlist${count > 0 ? ` (${count})` : ""}`} />
                    <TabBtn active={tab === "add"}  onClick={() => setTab("add")}  ch="+ Add User" />
                </div>
                {tab === "list" && <WatchlistTab onUpdate={refreshCount} />}
                {tab === "add"  && <AddTab onAdded={() => { refreshCount(); setTab("list") }} />}
            </ModalContent>
        </ModalRoot>
    )
}

}

// ── plugin ────────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "UserRadar",
    description: "Watch specific users and get notified about their messages, edits, deletes, typing, voice, profile changes, and more.",
    authors: [{ id: 0n, name: "mubashir" }],
    settings,

    settingsAboutComponent() {
        return (
            <div>
                <Text variant="heading-sm/semibold" style={{ marginBottom: 8 }}>Watchlist</Text>
                <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
                    Manage the users you're tracking. You can also right-click any user → "Watch User" to add on the fly.
                </Text>
                <button style={{ background: "var(--brand-500)", color: "#fff", border: "none", borderRadius: 4, padding: "8px 14px", cursor: "pointer", fontWeight: 600, fontSize: 14, width: "100%" }}
                    onClick={() => openModal(p => <WatchlistModal modalProps={p} />)}>
                    Open Watchlist Manager
                </button>
            </div>
        )
    },

    flux: {
        MESSAGE_CREATE(evt: MsgCreateEvent) {
            const { message, guildId, channelId } = evt
            if (!message?.author?.id || !featureOn(settings, message.author.id, "msgs", "globalMsgs")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === channelId) return
            const u = UserStore.getUser(message.author.id)
            const name = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            const dn = label ? `${label} (${name})` : name
            if (message.type === 7) { push({ title: `${dn} joined a server`, body: "Click to view", icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, channelId, message.id) }); return }
            push({ title: `${dn} sent a message`, body: preview(message.content, message.attachments?.[0]?.filename), icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, channelId, message.id) })
        },

        MESSAGE_UPDATE(evt: MsgUpdateEvent) {
            const { message, guildId } = evt
            if (!message?.author?.id || !featureOn(settings, message.author.id, "edits", "globalEdits")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === message.channel_id) return
            const u = UserStore.getUser(message.author.id)
            const name = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            push({ title: `${label ? `${label} (${name})` : name} edited a message`, body: preview(message.content, message.attachments?.[0]?.filename), icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, message.channel_id, message.id) })
        },

        async MESSAGE_DELETE(evt: MsgDeleteEvent) {
            if (!evt?.channelId || !evt?.id) return
            let msg: Message | undefined = MessageStore.getMessage(evt.channelId, evt.id)
            if (!msg) { const s = await tryLoadLoggedMsgs(); msg = s?.[evt.id] as Message | undefined }
            if (!msg?.author?.id || !featureOn(settings, msg.author.id, "deletes", "globalDeletes")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === msg.channel_id) return
            const u = UserStore.getUser(msg.author.id)
            const name = displayName(u ?? msg.author)
            const label = getWatchedUser(settings, msg.author.id)?.nick
            push({ title: `${label ? `${label} (${name})` : name} deleted a message`, body: settings.store.showPreview && msg.content ? `"${trunc(msg.content, settings.store.previewLen)}"` : "Message was deleted", icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(evt.guildId, msg!.channel_id, msg!.id) })
        },

        TYPING_START(evt: TypingEvent) {
            if (!evt?.userId || !evt?.channelId || !featureOn(settings, evt.userId, "typing", "globalTyping")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === evt.channelId) return
            const u = UserStore.getUser(evt.userId)
            if (!u) return
            const label = getWatchedUser(settings, evt.userId)?.nick
            const ch = ChannelStore.getChannel(evt.channelId)
            push({ title: `${label ? `${label} (${displayName(u)})` : displayName(u)} is typing…`, body: ch?.name ? `In #${ch.name}` : "Click to jump", icon: u.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(ch?.guild_id, evt.channelId) })
        },

        USER_UPDATE(evt: { user: any }) {
            if (!evt?.user?.id || !isWatched(settings, evt.user.id) || !featureOn(settings, evt.user.id, "profile", "globalProfile")) return
            const old = profileCache[evt.user.id]
            if (!old) return
            checkProfile(evt.user.id, { ...old, user: { ...old.user, ...camelize(evt.user) } })
        },

        async USER_PROFILE_FETCH_SUCCESS(rawEvt: ProfileFetchEvent) {
            if (!rawEvt?.user?.id) return
            checkProfile(rawEvt.user.id, camelize(rawEvt))
        },

        VOICE_STATE_UPDATES(evt: VoiceStateEvent) {
            for (const state of evt.voiceStates ?? []) {
                const { userId, channelId, guildId } = state
                if (!featureOn(settings, userId, "voice", "globalVoice")) continue
                const prev = vcCache[userId] ?? null
                vcCache[userId] = channelId ?? null
                if (prev === (channelId ?? null)) continue
                const u = UserStore.getUser(userId)
                const label = getWatchedUser(settings, userId)?.nick
                const dn = label ? `${label} (${displayName(u)})` : displayName(u)
                const icon = u?.getAvatarURL(undefined, undefined, false)
                if (!prev && channelId) { const ch = ChannelStore.getChannel(channelId); push({ title: `${dn} joined voice`, body: ch ? `#${ch.name}` : "Click to view", icon, onClick: () => jumpTo(guildId, channelId) }) }
                else if (prev && !channelId) { push({ title: `${dn} left voice`, body: "They disconnected", icon, onClick: () => openUserProfile(userId) }) }
                else if (prev && channelId && prev !== channelId) { const ch = ChannelStore.getChannel(channelId); push({ title: `${dn} moved voice channels`, body: ch ? `Now in #${ch.name}` : "Click to view", icon, onClick: () => jumpTo(guildId, channelId) }) }
            }
        },

        PRESENCE_UPDATES(evt: PresenceEvent) {
            for (const update of evt.updates ?? []) {
                const { id } = update.user
                if (!featureOn(settings, id, "status", "globalStatus")) continue
                const prev = statusCache[id]
                statusCache[id] = update.status
                if (!prev || prev === update.status) continue
                const u = UserStore.getUser(id)
                const label = getWatchedUser(settings, id)?.nick
                push({ title: `${label ? `${label} (${displayName(u)})` : displayName(u)} is now ${update.status} ${STATUS_EMOJI[update.status] ?? ""}`, body: `Was: ${prev} ${STATUS_EMOJI[prev] ?? ""}`, icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => openUserProfile(id) })
            }
        },
    },

    async start() {
        addContextMenuPatch("user-context", userContextPatch)
        if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission()
        for (const wu of getWatchlist(settings)) {
            try { const { body } = await RestAPI.get({ url: `/users/${wu.id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } }); profileCache[wu.id] = camelize(body) } catch { }
        }
        pollTimer = setInterval(pollProfiles, 5 * 60 * 1000)
        tryLoadLoggedMsgs().then(m => { if (!m) log.warn("message logger not found") })
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
        addUser(settings, id)
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `Now watching ${displayName(UserStore.getUser(id))}`, id: Toasts.genId() })
        try { const { body } = await RestAPI.get({ url: `/users/${id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } }); profileCache[id] = camelize(body) } catch { }
    },

    unwatchUser(id: string) {
        removeUser(settings, id)
        delete profileCache[id]; delete vcCache[id]; delete statusCache[id]
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `Stopped watching ${displayName(UserStore.getUser(id))}`, id: Toasts.genId() })
    },
})

// ── context menu ──────────────────────────────────────────────────────────────

const userContextPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.user || props.user.id === UserStore.getCurrentUser()?.id) return
    const { id } = props.user
    const watching = isWatched(settings, id)
    if (children.some((c: any) => c?.props?.id === "userradar-group")) return
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuGroup id="userradar-group">
            <Menu.MenuItem id="userradar-toggle" label={watching ? "👁 Stop Watching User" : "👁 Watch User"}
                action={() => { const p = Vencord.Plugins.plugins["UserRadar"] as any; watching ? p.unwatchUser(id) : p.watchUser(id) }} />
            {watching && <Menu.MenuItem id="userradar-manage" label="⚙ Manage Watchlist" action={() => openModal(p => <WatchlistModal modalProps={p} />)} />}
        </Menu.MenuGroup>
    )
}
