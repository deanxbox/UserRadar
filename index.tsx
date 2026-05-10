// index.tsx - k1ng_op
// userradar - watch people on discord and get notified when they do stuff

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

// stuff that lives as long as the plugin is running
const profileCache: Record<string, any> = {}   // last known profile per user
const vcCache: Record<string, string | null> = {}  // last known vc per user
const statusCache: Record<string, string> = {}     // last known status per user
let loggedMsgs: Record<string, Message> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

// try to hook into vc-message-logger-enhanced for delete content
// if its not installed, deletes just wont have message content - nbd
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

// settings
const settings = definePluginSettings({
    watchlist:          { type: OptionType.STRING,  default: "[]",    description: "watchlist json (dont touch this)",                         hidden: true },
    globalMsgs:         { type: OptionType.BOOLEAN, default: true,    description: "notify on new messages" },
    globalEdits:        { type: OptionType.BOOLEAN, default: true,    description: "notify on edits" },
    globalDeletes:      { type: OptionType.BOOLEAN, default: true,    description: "notify on deletes (needs vc-message-logger-enhanced for content)" },
    globalTyping:       { type: OptionType.BOOLEAN, default: true,    description: "notify when someone starts typing" },
    globalProfile:      { type: OptionType.BOOLEAN, default: true,    description: "notify on profile changes (avatar, bio, banner etc)" },
    globalVoice:        { type: OptionType.BOOLEAN, default: true,    description: "notify on voice joins/leaves" },
    globalStatus:       { type: OptionType.BOOLEAN, default: false,   description: "notify on status changes (kinda spammy, off by default)" },
    showPreview:        { type: OptionType.BOOLEAN, default: true,    description: "show message content in notifs" },
    previewLen:         { type: OptionType.NUMBER,  default: 120,     description: "how many chars to show in preview (0 = no limit)" },
    quietHours:         { type: OptionType.BOOLEAN, default: false,   description: "silence notifs during certain hours" },
    quietStart:         { type: OptionType.STRING,  default: "23:00", description: "quiet hours start (24h format)" },
    quietEnd:           { type: OptionType.STRING,  default: "07:00", description: "quiet hours end (24h format)" },
    skipCurrentChannel: { type: OptionType.BOOLEAN, default: true,    description: "skip notif if youre already looking at that channel" },
    debugLog:           { type: OptionType.BOOLEAN, default: false,   description: "log everything to console (for debugging)" },
})

// notif helpers
function trunc(s: string, max: number) {
    return max > 0 && s.length > max ? s.slice(0, max) + "…" : s
}

function preview(content: string, file?: string) {
    if (!settings.store.showPreview) return "click to jump"
    return trunc(content || file || "click to jump", settings.store.previewLen)
}

function jumpTo(guildId?: string, channelId?: string, msgId?: string) {
    if (guildId)   findByProps("transitionToGuildSync")?.transitionToGuildSync(guildId)
    if (channelId) findByProps("selectChannel")?.selectChannel({ guildId: guildId ?? "@me", channelId, messageId: msgId })
}

function push(opts: { title: string; body: string; icon?: string; onClick?: () => void }) {
    if (inQuietHours(settings)) return
    if (settings.store.debugLog) log.info(`>> ${opts.title} — ${opts.body}`)

    // always show in-app toast
    Notifications.showNotification({
        title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick
    })

    // also try os notification when discord isnt focused (silent fail is fine)
    if (!document.hasFocus()) {
        try {
            const n = new window.Notification(opts.title, { body: opts.body, icon: opts.icon })
            if (opts.onClick) n.onclick = () => { window.focus(); opts.onClick!() }
        } catch { }
    }
}

// profile change detection
// track these fields and notify if any of them change
const WATCH_FIELDS = ["username", "globalName", "avatar", "bio", "banner", "bannerColor", "accentColor"] as const
const FIELD_NAMES: Record<string, string> = {
    username: "username", globalName: "display name", avatar: "avatar",
    bio: "bio", banner: "banner", bannerColor: "banner color", accentColor: "accent color"
}

function checkProfile(uid: string, fresh: any) {
    if (!isWatched(settings, uid)) return
    if (!featureOn(settings, uid, "profile", "globalProfile")) return

    const old = profileCache[uid]
    if (!old) { profileCache[uid] = fresh; return }

    const changed = WATCH_FIELDS.filter(f => fresh.user?.[f] !== old.user?.[f])
    if (!changed.length) return

    const u = UserStore.getUser(uid)
    const name = displayName(fresh.user)
    const label = getWatchedUser(settings, uid)?.nick

    push({
        title: `${label ? `${label} (${name})` : name} changed their profile`,
        body: changed.map(f => FIELD_NAMES[f]).join(", "),
        icon: u?.getAvatarURL(undefined, undefined, false),
        onClick: () => openUserProfile(uid)
    })
    profileCache[uid] = fresh
}

// poll profiles every 5 mins
// discord doesnt push bio/banner changes over ws so this is the only way
async function pollProfiles() {
    const list = getWatchlist(settings)
    if (!list.length) return
    for (const wu of list) {
        try {
            const { body } = await RestAPI.get({
                url: `/users/${wu.id}/profile`,
                query: { with_mutual_guilds: false, with_mutual_friends_count: false }
            })
            checkProfile(wu.id, camelize(body))
        } catch { }
        await new Promise(r => setTimeout(r, 1500))  // dont hammer the api
    }
}

// cdn url helpers (dont use getAvatarURL bc its signature keeps changing)
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
    try { return `https://cdn.discordapp.com/banners/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=480` }
    catch { return null }
}

function hexColor(n?: number | null) {
    if (n == null) return null
    try { return "#" + n.toString(16).padStart(6, "0") } catch { return null }
}

const FALLBACK_AV = "https://cdn.discordapp.com/embed/avatars/0.png"

// inject styles once on modal open, never during render
const STYLE_ID = "ur-s7"
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement("style")
    s.id = STYLE_ID
    s.textContent = `
        @keyframes ur-in   { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:none } }
        @keyframes ur-spin { to { transform:rotate(360deg) } }

        .ur-card {
            border-radius:14px; overflow:hidden; margin-bottom:6px;
            border:1px solid var(--background-modifier-accent);
            background:var(--background-secondary-alt, var(--background-secondary));
            transition:border-color .18s, box-shadow .18s, transform .12s;
            animation:ur-in .16s ease;
        }
        .ur-card:hover {
            border-color:rgba(88,101,242,.5);
            box-shadow:0 4px 24px rgba(0,0,0,.22);
            transform:translateY(-1px);
        }
        .ur-row       { display:flex; align-items:center; gap:13px; padding:11px 13px; }
        .ur-av        { width:46px; height:46px; border-radius:50%; object-fit:cover; display:block; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,.3); }
        .ur-av-wrap   { position:relative; flex-shrink:0; }
        .ur-av-dot    { position:absolute; bottom:0; right:0; width:11px; height:11px; border-radius:50%; background:var(--brand-500); border:2px solid var(--background-secondary); }
        .ur-name      { font-weight:700; font-size:14px; color:var(--header-primary); line-height:1.2; }
        .ur-sub       { font-size:11px; color:var(--text-muted); margin-top:2px; }
        .ur-nick-pill { display:inline-block; font-size:10px; font-weight:700; padding:2px 8px; border-radius:20px; background:rgba(88,101,242,.2); color:var(--brand-400); margin-left:5px; }
        .ur-actions   { display:flex; gap:2px; flex-shrink:0; margin-left:auto; }

        .ur-ibtn {
            display:inline-flex; align-items:center; justify-content:center;
            width:30px; height:30px; border-radius:8px; cursor:pointer; font-size:14px;
            transition:background .12s, color .12s, transform .1s;
            color:var(--interactive-normal); background:transparent; user-select:none;
        }
        .ur-ibtn:hover      { background:var(--background-modifier-hover); color:var(--interactive-hover); transform:scale(1.1); }
        .ur-ibtn.d:hover    { background:rgba(237,66,69,.15); color:var(--status-danger); }

        .ur-chips    { display:grid; grid-template-columns:1fr 1fr; gap:5px; padding:4px 12px 12px; }
        .ur-chip {
            display:flex; align-items:center; gap:7px; padding:7px 10px; border-radius:9px;
            border:1.5px solid var(--background-modifier-accent);
            background:var(--background-tertiary); cursor:pointer; user-select:none;
            transition:all .14s; opacity:.65;
        }
        .ur-chip.on          { border-color:rgba(88,101,242,.5); background:rgba(88,101,242,.12); opacity:1; }
        .ur-chip-lbl         { flex:1; font-size:12px; font-weight:500; color:var(--text-muted); }
        .ur-chip.on .ur-chip-lbl { color:var(--text-normal); }

        .ur-tgl       { position:relative; width:30px; height:17px; border-radius:9px; flex-shrink:0; background:var(--background-modifier-accent); transition:background .14s; }
        .ur-tgl.on    { background:var(--brand-500); }
        .ur-tgl-thumb { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.3); transition:left .14s; }
        .ur-tgl.on .ur-tgl-thumb { left:15px; }

        .ur-spin { display:inline-block; width:12px; height:12px; border-radius:50%; border:2px solid rgba(255,255,255,.3); border-top-color:#fff; animation:ur-spin .6s linear infinite; vertical-align:middle; }
        .ur-err  { display:flex; gap:10px; align-items:flex-start; margin-top:12px; padding:10px 13px; border-radius:10px; background:rgba(237,66,69,.08); border:1px solid rgba(237,66,69,.3); }
    `
    document.head.appendChild(s)
}

// tiny reusable div-button so i dont repeat myself
// (using actual <button> causes black text from browser UA styles)
function Btn({ onClick, style, title, ch }: { onClick: () => void; style?: any; title?: string; ch: any }) {
    return (
        <div role="button" tabIndex={0} title={title} onClick={onClick}
            onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
            style={{ cursor: "pointer", userSelect: "none", ...style }}>
            {ch}
        </div>
    )
}

// icon button - the small ones on each user card
function IBtn({ onClick, title, danger, ch }: { onClick: () => void; title?: string; danger?: boolean; ch: any }) {
    return (
        <div role="button" tabIndex={0} title={title} onClick={onClick}
            onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
            className={`ur-ibtn${danger ? " d" : ""}`}>
            {ch}
        </div>
    )
}

function Tgl({ on, toggle }: { on: boolean; toggle: () => void }) {
    return (
        <Btn onClick={toggle} ch={
            <div className={`ur-tgl${on ? " on" : ""}`}>
                <div className="ur-tgl-thumb" />
            </div>
        } />
    )
}

function TabBtn({ active, onClick, ch }: { active: boolean; onClick: () => void; ch: any }) {
    return (
        <Btn onClick={onClick} ch={ch} style={{
            flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 9, fontSize: 13,
            fontWeight: active ? 700 : 500,
            color: active ? "var(--header-primary)" : "var(--text-muted)",
            background: active ? "var(--background-primary)" : "transparent",
            boxShadow: active ? "0 1px 5px rgba(0,0,0,.25)" : "none",
            transition: "background .12s, color .12s",
        }} />
    )
}

// the override chips on each user card
// null = use global, true/false = override
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
    on: boolean; overridden: boolean; icon: string; label: string
    onClick: () => void; onRight: () => void
}) {
    return (
        <div className={`ur-chip${on ? " on" : ""}`} role="button" tabIndex={0}
            onClick={onClick}
            onContextMenu={(e: any) => { e.preventDefault(); onRight() }}
            onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") onClick() }}
            title={overridden ? "overriding global — right-click to reset" : "click to override global"}>
            <span style={{ fontSize: 13 }}>{icon}</span>
            <span className="ur-chip-lbl">{label}</span>
            {overridden && <span style={{ fontSize: 7, color: "var(--brand-400)" }}>●</span>}
            <Tgl on={on} toggle={onClick} />
        </div>
    )
}

// single user row in the watchlist
function UserCard({ user, refresh, remove }: { user: WatchedUser; refresh: () => void; remove: () => void }) {
    const [nick,     setNick] = React.useState(user.nick ?? "")
    const [expanded, setExp]  = React.useState(false)
    const [editNick, setEdit] = React.useState(false)

    const du      = React.useMemo(() => { try { return UserStore.getUser(user.id) ?? null } catch { return null } }, [user.id])
    const av      = duAvatar(du, user.id)
    const name    = (du ? displayName(du) : null) || user.nick || user.id
    const ovs     = user.overrides ?? {} as any
    const hasOv   = Object.values(ovs).some((v: any) => v !== null && v !== undefined)
    const addedDate = React.useMemo(() => { try { return new Date(user.addedAt).toLocaleDateString() } catch { return "?" } }, [user.addedAt])

    const saveNick = () => { patchUser(settings, user.id, { nick: nick.trim() }); setEdit(false); refresh() }
    const setOv = (key: string, val: boolean | null) => {
        patchUser(settings, user.id, { overrides: { ...ovs, [key]: val } as any })
        refresh()
    }

    return (
        <div className="ur-card">
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
                    <IBtn onClick={() => setEdit(v => !v)} title="edit label" ch="✏️" />
                    <IBtn onClick={() => setExp(v => !v)} title="per-user overrides"
                        ch={<span style={{ fontSize: 10, fontWeight: 700 }}>{expanded ? "▲" : "▼"}</span>} />
                    <IBtn onClick={remove} title="unwatch" danger ch="🗑" />
                </div>
            </div>

            {editNick && (
                <div style={{ display: "flex", gap: 8, padding: "8px 12px 12px", borderTop: "1px solid var(--background-modifier-accent)", background: "var(--background-tertiary)" }}>
                    <div style={{ flex: 1 }}>
                        <TextInput
                            value={nick}
                            onChange={(v: string) => setNick(v)}
                            placeholder={`label for ${name}`}
                            onKeyDown={(e: any) => { if (e.key === "Enter") saveNick(); if (e.key === "Escape") setEdit(false) }}
                            autoFocus />
                    </div>
                    <Button size={Button.Sizes.MEDIUM} onClick={saveNick}>Save</Button>
                    <Button size={Button.Sizes.MEDIUM} color={Button.Colors.TRANSPARENT} onClick={() => setEdit(false)}>Cancel</Button>
                </div>
            )}

            {expanded && (
                <div style={{ borderTop: "1px solid var(--background-modifier-accent)" }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "8px 13px 3px" }}>
                        per-user overrides · right-click a chip to reset it
                    </div>
                    <div className="ur-chips">
                        {OV_ITEMS.map(item => {
                            const isOn = featureOn(settings, user.id, item.key as any, item.gk)
                            const isOv = ovs[item.key] !== null && ovs[item.key] !== undefined
                            return (
                                <Chip key={item.key} on={isOn} overridden={isOv} icon={item.icon} label={item.label}
                                    onClick={() => {
                                        if (!isOv) setOv(item.key, !isOn)
                                        else if (ovs[item.key] === true) setOv(item.key, false)
                                        else setOv(item.key, null)
                                    }}
                                    onRight={() => setOv(item.key, null)} />
                            )
                        })}
                    </div>
                    <div style={{ padding: "0 12px 12px" }}>
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.TRANSPARENT}
                            onClick={() => {
                                const r: any = {}
                                OV_ITEMS.forEach(i => { r[i.key] = null })
                                patchUser(settings, user.id, { overrides: r })
                                refresh()
                            }}>
                            ↩ reset all to global
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}

// the watchlist tab
function WatchlistTab({ onUpdate }: { onUpdate: () => void }) {
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
                return [displayName(du), u.nick ?? "", u.id].join(" ").toLowerCase().includes(search.toLowerCase())
            } catch { return true }
        })
        : users

    if (!users.length) return (
        <div style={{ textAlign: "center", padding: "52px 20px" }}>
            <div style={{ fontSize: 52, marginBottom: 14, opacity: .4 }}>👁</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--header-primary)", marginBottom: 6 }}>nothing here yet</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>go to + add user to start tracking someone</div>
        </div>
    )

    return (
        <>
            {users.length > 3 && (
                <div style={{ marginBottom: 10 }}>
                    <TextInput value={search} onChange={(v: string) => setSearch(v)} placeholder="search by name, label, or id…" />
                </div>
            )}
            {shown.length === 0
                ? <div style={{ textAlign: "center", padding: "24px 0", fontSize: 13, color: "var(--text-muted)" }}>no results for "{search}"</div>
                : shown.map(u => (
                    <UserCard key={u.id} user={u} refresh={refresh}
                        remove={() => { removeUser(settings, u.id); refresh() }} />
                ))
            }
        </>
    )
}

// add user tab - step 1: enter id, step 2: confirm with preview card
type LK =
    | { stage: "idle" }
    | { stage: "loading" }
    | { stage: "found"; user: any; av: string; banner: string | null; accent: string | null }
    | { stage: "error"; msg: string }

function AddTab({ onAdded }: { onAdded: () => void }) {
    const [rawId, setRawId] = React.useState("")
    const [label, setLabel] = React.useState("")
    const [lk, setLk]       = React.useState<LK>({ stage: "idle" })

    const cleanId = rawId.trim().replace(/\D/g, "")

    const doLookup = () => {
        if (!cleanId)                                    return setLk({ stage: "error", msg: "paste a user id first" })
        if (cleanId.length < 17 || cleanId.length > 20) return setLk({ stage: "error", msg: "discord ids are 17-20 digits" })
        if (isWatched(settings, cleanId))                return setLk({ stage: "error", msg: "already watching this person" })

        setLk({ stage: "loading" })

        RestAPI.get({
            url: `/users/${cleanId}/profile`,
            query: { with_mutual_guilds: false, with_mutual_friends_count: false }
        }).then((res: any) => {
            const d = camelize(res.body)
            setLk({
                stage: "found",
                user:   d.user,
                av:     safeAvatar(d.user?.id ?? cleanId, d.user?.avatar, 128),
                banner: bannerUrl(d.user?.id ?? cleanId, d.user?.banner),
                accent: hexColor(d.user?.accentColor),
            })
        }).catch((e: any) => {
            const s = e?.status ?? e?.response?.status
            setLk({
                stage: "error",
                msg: s === 404 ? "user not found"
                   : s === 403 ? "profile is private — you can still add by id though"
                   : `request failed${s ? ` (${s})` : ""}`,
            })
        })
    }

    const doAdd = () => {
        if (lk.stage !== "found") return
        addUser(settings, cleanId, label.trim())
        setRawId(""); setLabel(""); setLk({ stage: "idle" })
        onAdded()
    }

    // step 2: preview card
    if (lk.stage === "found") return (
        <div>
            <div style={{ borderRadius: 12, overflow: "hidden", marginBottom: 16, border: "1px solid var(--background-modifier-accent)" }}>
                <div style={{
                    height: lk.banner ? 96 : 64, position: "relative",
                    background: lk.banner
                        ? `url(${lk.banner}) center/cover no-repeat`
                        : lk.accent
                            ? `linear-gradient(135deg, ${lk.accent}bb, ${lk.accent}44)`
                            : "linear-gradient(135deg, #5865f2, #4752c4)",
                }}>
                    <img src={lk.av} alt="" style={{
                        position: "absolute", bottom: -24, left: 16,
                        width: 58, height: 58, borderRadius: "50%",
                        border: "4px solid var(--modal-background, var(--background-primary))",
                        objectFit: "cover", boxShadow: "0 2px 12px rgba(0,0,0,.4)",
                    }} onError={(e: any) => { e.target.src = FALLBACK_AV }} />
                </div>
                <div style={{ padding: "30px 16px 14px", background: "var(--background-secondary)" }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "var(--header-primary)" }}>
                        {lk.user?.globalName || lk.user?.username || cleanId}
                    </div>
                    {lk.user?.globalName && (
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>@{lk.user.username}</div>
                    )}
                    {lk.user?.bio && (
                        <div style={{ fontSize: 13, color: "var(--text-normal)", marginTop: 8, lineHeight: 1.45, opacity: .8, overflow: "hidden", maxHeight: "2.9em" }}>
                            {lk.user.bio}
                        </div>
                    )}
                </div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--header-secondary)", marginBottom: 6 }}>
                label <span style={{ fontWeight: 400, textTransform: "none", color: "var(--text-muted)" }}>— optional</span>
            </div>
            <TextInput value={label} onChange={(v: string) => setLabel(v)}
                placeholder={'e.g. "bestie", "the rat", "coworker"'}
                onKeyDown={(e: any) => { if (e.key === "Enter") doAdd() }}
                autoFocus />
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 5, marginBottom: 16 }}>
                only you can see this
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={doAdd} size={Button.Sizes.MEDIUM} style={{ flex: 1 }}>Add to Watchlist</Button>
                <Button onClick={() => { setLk({ stage: "idle" }); setLabel("") }} size={Button.Sizes.MEDIUM} color={Button.Colors.TRANSPARENT}>
                    Cancel
                </Button>
            </div>
        </div>
    )

    // step 1: id input
    return (
        <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--header-secondary)", marginBottom: 6 }}>
                user id
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <TextInput value={rawId}
                        onChange={(v: string) => { setRawId(v); if (lk.stage === "error") setLk({ stage: "idle" }) }}
                        placeholder="e.g. 123456789012345678"
                        onKeyDown={(e: any) => { if (e.key === "Enter") doLookup() }}
                        autoFocus />
                </div>
                <Button onClick={doLookup} size={Button.Sizes.MEDIUM}
                    disabled={lk.stage === "loading" || !rawId.trim()} style={{ flexShrink: 0 }}>
                    {lk.stage === "loading"
                        ? <><span className="ur-spin" style={{ marginRight: 6 }} />looking up…</>
                        : "Look Up"}
                </Button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                enable <strong style={{ color: "var(--text-normal)" }}>developer mode</strong> in discord settings → right-click any user → copy user id
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

// the modal itself
function WatchlistModal({ modalProps }: { modalProps: any }) {
    React.useEffect(() => { injectStyles() }, [])

    const [tab,   setTab]   = React.useState<"list" | "add">("list")
    const [count, setCount] = React.useState(() => { try { return getWatchlist(settings).length } catch { return 0 } })

    const refreshCount = () => { try { setCount(getWatchlist(settings).length) } catch { setCount(0) } }

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "2px 0" }}>
                    <div style={{
                        width: 32, height: 32, borderRadius: 10, flexShrink: 0,
                        background: "linear-gradient(135deg, #5865f2, #4752c4)",
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17,
                    }}>👁</div>
                    <span style={{ fontSize: 17, fontWeight: 800, color: "var(--header-primary)" }}>UserRadar</span>
                    {count > 0 && (
                        <span style={{ background: "var(--brand-500)", color: "#fff", borderRadius: 12, fontSize: 11, fontWeight: 800, padding: "2px 8px" }}>
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

// the actual plugin
export default definePlugin({
    name: "UserRadar",
    description: "get notified when watched users send messages, edit/delete, type, change profile, join voice, change status",
    authors: [{ id: 641266820187160576, name: "k1ng_op" }],
    settings,

    settingsAboutComponent() {
        return (
            <div>
                <Text variant="heading-sm/semibold" style={{ marginBottom: 8 }}>Watchlist</Text>
                <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
                    manage who you're tracking below, or right-click any user → watch user to add them on the fly
                </Text>
                <button
                    style={{ background: "var(--brand-500)", color: "#fff", border: "none", borderRadius: 4, padding: "8px 14px", cursor: "pointer", fontWeight: 600, fontSize: 14, width: "100%" }}
                    onClick={() => openModal(p => <WatchlistModal modalProps={p} />)}>
                    open watchlist manager
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

            const u     = UserStore.getUser(message.author.id)
            const name  = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            const dn    = label ? `${label} (${name})` : name

            if (message.type === 7) {
                push({ title: `${dn} joined a server`, body: "click to view", icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, channelId, message.id) })
                return
            }
            push({ title: `${dn} sent a message`, body: preview(message.content, message.attachments?.[0]?.filename), icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, channelId, message.id) })
        },

        MESSAGE_UPDATE(evt: MsgUpdateEvent) {
            const { message, guildId } = evt
            if (!message?.author?.id) return
            if (!featureOn(settings, message.author.id, "edits", "globalEdits")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === message.channel_id) return

            const u     = UserStore.getUser(message.author.id)
            const name  = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            push({ title: `${label ? `${label} (${name})` : name} edited a message`, body: preview(message.content, message.attachments?.[0]?.filename), icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(guildId, message.channel_id, message.id) })
        },

        async MESSAGE_DELETE(evt: MsgDeleteEvent) {
            if (!evt?.channelId || !evt?.id) return
            let msg: Message | undefined = MessageStore.getMessage(evt.channelId, evt.id)
            if (!msg) {
                const store = await tryLoadLoggedMsgs()
                msg = store?.[evt.id] as Message | undefined
            }
            if (!msg?.author?.id) return
            if (!featureOn(settings, msg.author.id, "deletes", "globalDeletes")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === msg.channel_id) return

            const u     = UserStore.getUser(msg.author.id)
            const name  = displayName(u ?? msg.author)
            const label = getWatchedUser(settings, msg.author.id)?.nick
            const body  = settings.store.showPreview && msg.content
                ? `"${trunc(msg.content, settings.store.previewLen)}"`
                : "message was deleted"
            push({ title: `${label ? `${label} (${name})` : name} deleted a message`, body, icon: u?.getAvatarURL(undefined, undefined, false), onClick: () => jumpTo(evt.guildId, msg!.channel_id, msg!.id) })
        },

        TYPING_START(evt: TypingEvent) {
            if (!evt?.userId || !evt?.channelId) return
            if (!featureOn(settings, evt.userId, "typing", "globalTyping")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === evt.channelId) return

            const u = UserStore.getUser(evt.userId)
            if (!u) return

            const label = getWatchedUser(settings, evt.userId)?.nick
            const ch    = ChannelStore.getChannel(evt.channelId)
            push({
                title: `${label ? `${label} (${displayName(u)})` : displayName(u)} is typing…`,
                body: ch?.name ? `in #${ch.name}` : "click to jump",
                icon: u.getAvatarURL(undefined, undefined, false),
                onClick: () => jumpTo(ch?.guild_id, evt.channelId)
            })
        },

        USER_UPDATE(evt: { user: any }) {
            if (!evt?.user?.id) return
            if (!isWatched(settings, evt.user.id)) return
            if (!featureOn(settings, evt.user.id, "profile", "globalProfile")) return
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

                const u     = UserStore.getUser(userId)
                const label = getWatchedUser(settings, userId)?.nick
                const dn    = label ? `${label} (${displayName(u)})` : displayName(u)
                const icon  = u?.getAvatarURL(undefined, undefined, false)

                if (!prev && channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    push({ title: `${dn} joined voice`, body: ch ? `#${ch.name}` : "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                } else if (prev && !channelId) {
                    push({ title: `${dn} left voice`, body: "disconnected", icon, onClick: () => openUserProfile(userId) })
                } else if (prev && channelId && prev !== channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    push({ title: `${dn} moved to a different vc`, body: ch ? `now in #${ch.name}` : "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                }
            }
        },

        PRESENCE_UPDATES(evt: PresenceEvent) {
            for (const update of evt.updates ?? []) {
                const { id } = update.user
                if (!featureOn(settings, id, "status", "globalStatus")) continue

                const prev = statusCache[id]
                statusCache[id] = update.status
                if (!prev || prev === update.status) continue

                const u     = UserStore.getUser(id)
                const label = getWatchedUser(settings, id)?.nick
                push({
                    title: `${label ? `${label} (${displayName(u)})` : displayName(u)} is now ${update.status} ${STATUS_EMOJI[update.status] ?? ""}`,
                    body: `was: ${prev} ${STATUS_EMOJI[prev] ?? ""}`,
                    icon: u?.getAvatarURL(undefined, undefined, false),
                    onClick: () => openUserProfile(id)
                })
            }
        },
    },

    async start() {
        addContextMenuPatch("user-context", userContextPatch)

        if (typeof Notification !== "undefined" && Notification.permission === "default") {
            Notification.requestPermission()
        }

        // pre-fetch everyone as baseline so we dont false-positive on first poll
        for (const wu of getWatchlist(settings)) {
            try {
                const { body } = await RestAPI.get({ url: `/users/${wu.id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } })
                profileCache[wu.id] = camelize(body)
            } catch { }
        }

        pollTimer = setInterval(pollProfiles, 5 * 60 * 1000)

        tryLoadLoggedMsgs().then(m => {
            if (m) log.info("hooked into message logger")
            else   log.warn("message logger not found, delete content wont be available")
        })
    },

    stop() {
        removeContextMenuPatch("user-context", userContextPatch)
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        for (const k in profileCache)  delete profileCache[k]
        for (const k in vcCache)       delete vcCache[k]
        for (const k in statusCache)   delete statusCache[k]
        loggedMsgs = null
    },

    async watchUser(id: string) {
        addUser(settings, id)
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `now watching ${displayName(UserStore.getUser(id))}`, id: Toasts.genId() })
        try {
            const { body } = await RestAPI.get({ url: `/users/${id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } })
            profileCache[id] = camelize(body)
        } catch { }
    },

    unwatchUser(id: string) {
        removeUser(settings, id)
        delete profileCache[id]; delete vcCache[id]; delete statusCache[id]
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `stopped watching ${displayName(UserStore.getUser(id))}`, id: Toasts.genId() })
    },
})

// context menu patch - right click any user to watch/unwatch them
const userContextPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.user) return
    if (props.user.id === UserStore.getCurrentUser()?.id) return  // dont watch yourself lol
    if (children.some((c: any) => c?.props?.id === "userradar-group")) return

    const { id } = props.user
    const watching = isWatched(settings, id)

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuGroup id="userradar-group">
            <Menu.MenuItem
                id="userradar-toggle"
                label={watching ? "👁 Stop Watching" : "👁 Watch User"}
                action={() => {
                    const p = Vencord.Plugins.plugins["UserRadar"] as any
                    watching ? p.unwatchUser(id) : p.watchUser(id)
                }} />
            {watching && (
                <Menu.MenuItem
                    id="userradar-manage"
                    label="⚙ Manage Watchlist"
                    action={() => openModal(p => <WatchlistModal modalProps={p} />)} />
            )}
        </Menu.MenuGroup>
    )
}
