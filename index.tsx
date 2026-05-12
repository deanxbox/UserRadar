// index.tsx
// k1ng_op — userradar
// basically a stalker plugin lol, tracks people and notifies you when they do stuff

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu"
import { Notifications } from "@api/index"
import { definePluginSettings } from "@api/Settings"
import { getCurrentChannel, openUserProfile } from "@utils/discord"
import { openModal, ModalRoot, ModalHeader, ModalContent, ModalFooter, ModalCloseButton, ModalSize } from "@utils/modal"
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
    GuildMemberEvent, MsgCreateEvent, MsgDeleteEvent, MsgUpdateEvent,
    PresenceEvent, ProfileFetchEvent,
    TypingEvent, VoiceStateEvent, WatchedUser
} from "./types"

// in-memory state, resets when plugin stops
const profileCache:  Record<string, any>          = {}  // last profile snapshot we saw per user
const vcCache:       Record<string, string | null> = {}  // what vc they were last in
const statusCache:   Record<string, string>         = {}  // last status
const activityCache: Record<string, string | null>  = {}  // last activity (game/music/etc)
let loggedMsgs: Record<string, Message> | null = null
let pollTimer:  ReturnType<typeof setInterval> | null = null

// hook into vc-message-logger-enhanced if it's installed
// gives us deleted message content, otherwise we just say "message was deleted"
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

const settings = definePluginSettings({
    watchlist:          { type: OptionType.STRING,  default: "[]",    hidden: true,  description: "watchlist json — don't touch" },
    globalMsgs:         { type: OptionType.BOOLEAN, default: true,                   description: "notify: messages" },
    globalEdits:        { type: OptionType.BOOLEAN, default: true,                   description: "notify: edits" },
    globalDeletes:      { type: OptionType.BOOLEAN, default: true,                   description: "notify: deletes (needs vc-message-logger-enhanced for content)" },
    globalTyping:       { type: OptionType.BOOLEAN, default: true,                   description: "notify: typing" },
    globalProfile:      { type: OptionType.BOOLEAN, default: true,                   description: "notify: profile changes (bio, banner, username etc)" },
    globalAvatar:       { type: OptionType.BOOLEAN, default: true,                   description: "notify: avatar changes" },
    globalVoice:        { type: OptionType.BOOLEAN, default: true,                   description: "notify: voice joins/leaves/moves" },
    globalStatus:       { type: OptionType.BOOLEAN, default: false,                  description: "notify: status changes (pretty spammy, off by default)" },
    globalBoosts:       { type: OptionType.BOOLEAN, default: true,                   description: "notify: server boosts" },
    globalActivity:     { type: OptionType.BOOLEAN, default: false,                  description: "notify: activity changes (game/music/etc) — very spammy, off by default" },
    globalJoins:        { type: OptionType.BOOLEAN, default: true,                   description: "notify: server joins/leaves" },
    showPreview:        { type: OptionType.BOOLEAN, default: true,                   description: "show message content in notifs" },
    previewLen:         { type: OptionType.NUMBER,  default: 120,                    description: "max chars in preview (0 = no limit)" },
    quietHours:         { type: OptionType.BOOLEAN, default: false,                  description: "mute notifs during certain hours" },
    quietStart:         { type: OptionType.STRING,  default: "23:00",                description: "quiet hours start (24h)" },
    quietEnd:           { type: OptionType.STRING,  default: "07:00",                description: "quiet hours end (24h)" },
    skipCurrentChannel: { type: OptionType.BOOLEAN, default: true,                   description: "skip notif if you're already in that channel" },
    debugLog:           { type: OptionType.BOOLEAN, default: false,                  description: "log all events to console" },
})

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

    if (document.hasFocus()) {
        // discord focused = in-app toast
        Notifications.showNotification({ title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick })
    } else {
        // discord in background = os notification
        // fall back to in-app if os notif fails (no permission, blocked, whatever)
        try {
            const n = new window.Notification(opts.title, { body: opts.body, icon: opts.icon })
            if (opts.onClick) n.onclick = () => { window.focus(); opts.onClick!() }
        } catch {
            Notifications.showNotification({ title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick })
        }
    }
}

// profile diffing
// accent/banner colors are the worst — discord sends null, 0, and undefined
// completely interchangeably depending on which api endpoint you hit
// this normalizes all three to null so they don't spam false positives
function normColor(v: any): string | null {
    if (v == null || v === 0) return null
    return String(v)
}

const TEXT_FIELDS  = ["username", "globalName", "bio", "banner"] as const
const COLOR_FIELDS = ["bannerColor", "accentColor"] as const

const FIELD_LABEL: Record<string, string> = {
    username: "username", globalName: "display name", avatar: "avatar",
    bio: "bio", banner: "banner", bannerColor: "banner color", accentColor: "accent color",
}

function checkProfile(uid: string, fresh: any) {
    if (!isWatched(settings, uid)) return

    const old = profileCache[uid]
    if (!old) { profileCache[uid] = fresh; return }

    // avatar has its own setting so handle it separately
    if (fresh.user?.avatar !== old.user?.avatar) {
        if (featureOn(settings, uid, "avatar", "globalAvatar")) {
            const name  = displayName(fresh.user)
            const label = getWatchedUser(settings, uid)?.nick
            push({
                title: `${label ? `${label} (${name})` : name} changed their avatar`,
                body: "click to see",
                icon: fresh.user?.avatar ? `https://cdn.discordapp.com/avatars/${uid}/${fresh.user.avatar}.webp?size=128` : undefined,
                onClick: () => openUserProfile(uid),
            })
        }
        // always update cache even if we skipped the notif, keeps diff clean
        profileCache[uid] = { ...profileCache[uid], user: { ...profileCache[uid].user, avatar: fresh.user?.avatar } }
    }

    const changed: string[] = []
    for (const f of TEXT_FIELDS) {
        if ((fresh.user?.[f] ?? null) !== (old.user?.[f] ?? null)) changed.push(f)
    }
    for (const f of COLOR_FIELDS) {
        if (normColor(fresh.user?.[f]) !== normColor(old.user?.[f])) changed.push(f)
    }

    if (changed.length && featureOn(settings, uid, "profile", "globalProfile")) {
        const u     = UserStore.getUser(uid)
        const name  = displayName(fresh.user)
        const label = getWatchedUser(settings, uid)?.nick
        push({
            title: `${label ? `${label} (${name})` : name} updated their profile`,
            body: changed.map(f => FIELD_LABEL[f] ?? f).join(", "),
            icon: u ? safeAvatar(u.id, (u as any).avatar) : undefined,
            onClick: () => openUserProfile(uid),
        })
    }

    profileCache[uid] = fresh
}

// poll bio/banner every 5 min bc discord doesn't push those over websocket
// annoying but it's the only way
async function pollProfiles() {
    const list = getWatchlist(settings)
    if (!list.length) return
    for (const wu of list) {
        try {
            const { body } = await RestAPI.get({
                url: `/users/${wu.id}/profile`,
                query: { with_mutual_guilds: false, with_mutual_friends_count: false },
            })
            checkProfile(wu.id, camelize(body))
        } catch { }
        await new Promise(r => setTimeout(r, 1500))  // chill between requests
    }
}

// build avatar url ourselves instead of using getAvatarURL()
// that function's signature breaks every few discord updates, not worth the trouble
function safeAvatar(id: string, hash?: string | null, size = 80) {
    try {
        if (hash) return `https://cdn.discordapp.com/avatars/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=${size}`
        let idx = 0
        try { idx = Number(BigInt(id) % BigInt(6)) } catch { idx = parseInt(id.slice(-1), 10) % 6 || 0 }
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`
    } catch { return "https://cdn.discordapp.com/embed/avatars/0.png" }
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

// inject once on modal open
// only a spinner keyframe, everything else is inline styles
const STYLE_ID = "ur-s8"
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement("style")
    s.id = STYLE_ID
    s.textContent = `
        @keyframes ur-spin { to { transform:rotate(360deg) } }
        .ur-spin {
            display:inline-block; width:12px; height:12px; border-radius:50%;
            border:2px solid rgba(255,255,255,.3); border-top-color:#fff;
            animation:ur-spin .6s linear infinite; vertical-align:middle;
        }
    `
    document.head.appendChild(s)
}

// hardcoded colors so we don't fight CSS variables
// these match discord dark theme and won't randomly break if discord changes var names
const C = {
    headerPrimary:   "#f2f3f5",
    headerSecondary: "#b5bac1",
    textNormal:      "#dbdee1",
    textMuted:       "#949ba4",
    textDanger:      "#fa777c",
    bgPrimary:       "#313338",
    bgSecondary:     "#2b2d31",
    bgTertiary:      "#1e1f22",
    bgModifier:      "#3f4147",
    brand:           "#5865f2",
    brandLight:      "#949cf4",
    white:           "#ffffff",
    green:           "#3ba55d",
    red:             "#ed4245",
} as const

function modalAvatarUrl(userId: string, hash?: string | null): string {
    if (!hash) {
        let idx = 0
        try { idx = Number(BigInt(userId) % BigInt(6)) } catch { idx = parseInt(userId.slice(-1), 10) % 6 || 0 }
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`
    }
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=64`
}

// custom toggle bc discord's Switch component is a pain to import reliably
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            style={{
                width: 40, height: 24, borderRadius: 12,
                background: checked ? C.green : "#4e5058",
                cursor: "pointer", position: "relative",
                transition: "background 150ms ease", flexShrink: 0,
            }}
        >
            <div style={{
                position: "absolute", top: 2,
                left: checked ? 18 : 2,
                width: 20, height: 20, borderRadius: "50%",
                background: C.white, boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                transition: "left 150ms cubic-bezier(0.4,0,0.2,1)",
            }} />
        </div>
    )
}

type LookupState =
    | { stage: "idle" }
    | { stage: "loading" }
    | { stage: "found"; data: any; avatar: string }
    | { stage: "error"; msg: string }

// add user section at the top of the modal
// two-step: enter id -> look up -> confirm with preview card
function AddUserSection({ onAdded }: { onAdded: () => void }) {
    const [rawId, setRawId]   = React.useState("")
    const [label, setLabel]   = React.useState("")
    const [lookup, setLookup] = React.useState<LookupState>({ stage: "idle" })

    const cleanId = rawId.trim().replace(/\D/g, "")

    const doLookup = () => {
        if (!cleanId)                                    { setLookup({ stage: "error", msg: "enter a user id first" }); return }
        if (cleanId.length < 17 || cleanId.length > 20) { setLookup({ stage: "error", msg: "discord ids are 17-20 digits" }); return }
        if (isWatched(settings, cleanId))                { setLookup({ stage: "error", msg: "already on your watchlist" }); return }

        setLookup({ stage: "loading" })
        RestAPI.get({
            url: `/users/${cleanId}/profile`,
            query: { with_mutual_guilds: false, with_mutual_friends_count: false },
        }).then((res: any) => {
            const data = camelize(res.body)
            setLookup({ stage: "found", data: data.user, avatar: modalAvatarUrl(data.user.id, data.user.avatar) })
        }).catch((e: any) => {
            const s = e?.status ?? e?.response?.status
            setLookup({
                stage: "error",
                msg: s === 404 ? "user not found"
                   : s === 403 ? "profile is private (no shared server) — you can still add by id though"
                   : `request failed${s ? ` (${s})` : ""}`,
            })
        })
    }

    const doAdd = () => {
        if (lookup.stage !== "found") return
        addUser(settings, cleanId, label.trim())
        setRawId(""); setLabel(""); setLookup({ stage: "idle" })
        onAdded()
    }

    return (
        <div>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: C.headerPrimary, marginBottom: 10 }}>
                add user
            </div>

            {lookup.stage !== "found" && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                        <TextInput
                            placeholder="paste a discord user id"
                            value={rawId}
                            onChange={(v: string) => { setRawId(v); if (lookup.stage === "error") setLookup({ stage: "idle" }) }}
                            onKeyDown={(e: any) => { if (e.key === "Enter") doLookup() }}
                            autoFocus
                        />
                        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                            developer mode → right-click user → copy user id
                        </div>
                    </div>
                    <Button onClick={doLookup} disabled={lookup.stage === "loading"} size={Button.Sizes.MEDIUM} color={Button.Colors.BRAND}>
                        {lookup.stage === "loading"
                            ? <><span className="ur-spin" style={{ marginRight: 6 }} />looking up…</>
                            : "look up"}
                    </Button>
                </div>
            )}

            {lookup.stage === "error" && (
                <div style={{ fontSize: 13, color: C.textDanger, marginTop: 8 }}>{lookup.msg}</div>
            )}

            {lookup.stage === "found" && (
                <div style={{ marginTop: 12 }}>
                    {/* preview card */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: C.bgTertiary, borderRadius: 8, border: `1px solid ${C.bgModifier}` }}>
                        <img src={lookup.avatar} style={{ width: 48, height: 48, borderRadius: "50%", flexShrink: 0 }}
                            onError={(e: any) => { e.target.style.display = "none" }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 16, fontWeight: 600, color: C.headerPrimary }}>
                                {lookup.data.globalName || lookup.data.username}
                            </div>
                            {lookup.data.globalName && (
                                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>@{lookup.data.username}</div>
                            )}
                            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{lookup.data.id}</div>
                        </div>
                        {/* checkmark */}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: C.green }}>
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor"/>
                        </svg>
                    </div>

                    <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: C.headerPrimary, marginBottom: 6 }}>
                            label <span style={{ fontWeight: 400, color: C.textMuted }}>(optional, only you see this)</span>
                        </div>
                        <TextInput
                            placeholder='e.g. "bestie", "the rat", "ex"'
                            value={label}
                            onChange={(v: string) => setLabel(v)}
                            onKeyDown={(e: any) => { if (e.key === "Enter") doAdd() }}
                            autoFocus
                        />
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <Button onClick={doAdd} size={Button.Sizes.MEDIUM} color={Button.Colors.GREEN} style={{ flex: 1 }}>
                            add to watchlist
                        </Button>
                        <Button onClick={() => { setLookup({ stage: "idle" }); setLabel("") }} size={Button.Sizes.MEDIUM} look={Button.Looks.OUTLINED}>
                            cancel
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}

// override rows config — what shows in the expanded per-user panel
const OV_ROWS = [
    { label: "messages", key: "msgs",     gk: "globalMsgs"     },
    { label: "edits",    key: "edits",    gk: "globalEdits"    },
    { label: "deletes",  key: "deletes",  gk: "globalDeletes"  },
    { label: "typing",   key: "typing",   gk: "globalTyping"   },
    { label: "profile",  key: "profile",  gk: "globalProfile"  },
    { label: "avatar",   key: "avatar",   gk: "globalAvatar"   },
    { label: "voice",    key: "voice",    gk: "globalVoice"    },
    { label: "status",   key: "status",   gk: "globalStatus"   },
    { label: "boosts",   key: "boosts",   gk: "globalBoosts"   },
    { label: "activity", key: "activity", gk: "globalActivity" },
    { label: "joins",    key: "joins",    gk: "globalJoins"    },
] as const

// single user row in the watchlist
function WatchedRow({ user, refresh, onRemove }: { user: WatchedUser; refresh: () => void; onRemove: () => void }) {
    const [nick,     setNick]     = React.useState(user.nick || "")
    const [expanded, setExpanded] = React.useState(false)

    const du   = UserStore.getUser(user.id)
    const name = displayName(du) || user.id
    const ava  = du ? modalAvatarUrl(du.id, (du as any).avatar) : modalAvatarUrl(user.id, null)

    const saveNick = () => { patchUser(settings, user.id, { nick: nick || "" }); refresh() }

    const setOv = (key: keyof WatchedUser["overrides"], val: boolean | null) => {
        patchUser(settings, user.id, { overrides: { ...user.overrides, [key]: val } })
        refresh()
    }

    return (
        <div style={{ background: C.bgSecondary, borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>

                {/* click this area to expand overrides */}
                <div onClick={() => setExpanded(e => !e)}
                    style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, cursor: "pointer" }}>
                    <img src={ava} style={{ width: 40, height: 40, borderRadius: "50%", flexShrink: 0 }}
                        onError={(e: any) => { e.target.style.display = "none" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: C.headerPrimary }}>{name}</span>
                            {user.nick && (
                                <span style={{ background: C.brand, color: C.white, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                                    {user.nick}
                                </span>
                            )}
                        </div>
                        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                            {user.id} · {new Date(user.addedAt).toLocaleDateString()}
                        </div>
                    </div>
                </div>

                {/* label input — stop propagation so it doesn't toggle expand */}
                <div onClick={(e: any) => e.stopPropagation()} style={{ width: 100, flexShrink: 0 }}>
                    <TextInput
                        placeholder="label"
                        value={nick}
                        onChange={(v: string) => setNick(v)}
                        onBlur={saveNick}
                        onKeyDown={(e: any) => { if (e.key === "Enter") saveNick() }}
                    />
                </div>

                {/* chevron */}
                <div style={{ color: C.textMuted, padding: 4, display: "flex", alignItems: "center", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 200ms ease" }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>
                    </svg>
                </div>

                {/* remove button */}
                <div
                    role="button" tabIndex={0}
                    onClick={(e: any) => { e.stopPropagation(); onRemove() }}
                    onKeyDown={(e: any) => { if (e.key === "Enter") onRemove() }}
                    style={{ color: C.red, cursor: "pointer", padding: 4, display: "flex", alignItems: "center" }}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                    </svg>
                </div>
            </div>

            {/* per-user overrides panel */}
            {expanded && (
                <div style={{ padding: "0 14px 12px", borderTop: `1px solid ${C.bgModifier}` }}>
                    <div style={{ marginTop: 10, marginBottom: 4, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, color: C.headerSecondary }}>
                        per-user overrides
                    </div>
                    {OV_ROWS.map(row => {
                        const effective    = featureOn(settings, user.id, row.key as any, row.gk)
                        const isOverridden = (user.overrides as any)[row.key] !== null && (user.overrides as any)[row.key] !== undefined
                        return (
                            <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                                <div style={{ flex: 1, fontSize: 12, color: C.textMuted }}>
                                    {row.label}
                                    {isOverridden && (
                                        <span style={{ color: C.brandLight, marginLeft: 6, fontSize: 11, fontWeight: 500 }}>overriding global</span>
                                    )}
                                </div>
                                <Switch checked={effective} onChange={v => setOv(row.key as any, v)} />
                                {/* reset to global button, only shows when overriding */}
                                {isOverridden && (
                                    <div
                                        role="button" tabIndex={0} title="reset to global"
                                        onClick={() => setOv(row.key as any, null)}
                                        onKeyDown={(e: any) => { if (e.key === "Enter") setOv(row.key as any, null) }}
                                        style={{ color: C.textMuted, cursor: "pointer", fontSize: 13, padding: "0 4px" }}
                                    >
                                        ↩
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

function WatchlistModal({ modalProps }: { modalProps: any }) {
    React.useEffect(() => { injectStyles() }, [])

    const [users, setUsers] = React.useState<WatchedUser[]>(() => { try { return getWatchlist(settings) } catch { return [] } })
    const [query, setQuery] = React.useState("")

    const refresh = () => { try { setUsers(getWatchlist(settings)) } catch { setUsers([]) } }

    const filtered = users.filter(u => {
        if (!query.trim()) return true
        const q  = query.toLowerCase()
        const du = UserStore.getUser(u.id)
        return [displayName(du), u.nick ?? "", u.id].join(" ").toLowerCase().includes(q)
    })

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <div style={{ flex: 1, fontSize: 20, fontWeight: 700, color: C.headerPrimary }}>
                    👁 UserRadar
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent style={{ paddingBottom: 16 }}>
                <div style={{ padding: "0 16px" }}>
                    <AddUserSection onAdded={refresh} />

                    <div style={{ height: 1, background: C.bgModifier, margin: "16px 0" }} />

                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                        <div style={{ flex: 1, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: C.headerPrimary }}>
                            watchlist <span style={{ color: C.textMuted, fontWeight: 400 }}>({users.length})</span>
                        </div>
                        {users.length > 3 && (
                            <div style={{ width: 220 }}>
                                <TextInput placeholder="search name, label, id…" value={query} onChange={(v: string) => setQuery(v)} />
                            </div>
                        )}
                    </div>

                    {users.length === 0 && (
                        <div style={{ textAlign: "center", padding: "40px 0" }}>
                            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.5 }}>👻</div>
                            <div style={{ fontSize: 15, fontWeight: 600, color: C.headerPrimary }}>nobody here yet</div>
                            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>add someone above to start tracking them</div>
                        </div>
                    )}

                    {filtered.length === 0 && users.length > 0 && (
                        <div style={{ textAlign: "center", padding: "24px 0", fontSize: 13, color: C.textMuted }}>
                            no results for "{query}"
                        </div>
                    )}

                    {filtered.map(u => (
                        <WatchedRow key={u.id} user={u} refresh={refresh}
                            onRemove={() => { removeUser(settings, u.id); refresh() }} />
                    ))}
                </div>
            </ModalContent>

            <ModalFooter>
                <div style={{ fontSize: 12, color: C.textMuted, flex: 1 }}>
                    {users.length} user{users.length !== 1 ? "s" : ""} watched
                </div>
                <Button onClick={modalProps.onClose} look={Button.Looks.OUTLINED} color={Button.Colors.PRIMARY}>
                    close
                </Button>
            </ModalFooter>
        </ModalRoot>
    )
}

export default definePlugin({
    name: "UserRadar",
    description: "track users and get notified when they message, edit, delete, type, change profile/avatar, vc, status, activity, boost, join/leave servers",
    authors: [{ id: 641266820187160576, name: "k1ng_op" }],
    settings,

    settingsAboutComponent() {
        return (
            <div>
                <Text variant="heading-sm/semibold" style={{ marginBottom: 8 }}>watchlist</Text>
                <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
                    manage who you're tracking, or right-click any user → watch user
                </Text>
                <button
                    style={{ background: "var(--brand-500)", color: "#fff", border: "none", borderRadius: 4, padding: "8px 14px", cursor: "pointer", fontWeight: 600, fontSize: 14, width: "100%" }}
                    onClick={() => openModal(p => <WatchlistModal modalProps={p} />)}
                >
                    open watchlist
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
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined

            // type 8 = boost message, type 7 = server join message
            if (message.type === 8) {
                if (!featureOn(settings, message.author.id, "boosts", "globalBoosts")) return
                push({ title: `${dn} boosted a server 🚀`, body: "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                return
            }
            if (message.type === 7) {
                push({ title: `${dn} joined a server`, body: "click to view", icon, onClick: () => jumpTo(guildId, channelId, message.id) })
                return
            }

            push({
                title: `${dn} sent a message`,
                body: preview(message.content, message.attachments?.[0]?.filename),
                icon,
                onClick: () => jumpTo(guildId, channelId, message.id),
            })
        },

        MESSAGE_UPDATE(evt: MsgUpdateEvent) {
            const { message, guildId } = evt
            if (!message?.author?.id) return
            if (!featureOn(settings, message.author.id, "edits", "globalEdits")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === message.channel_id) return

            const u     = UserStore.getUser(message.author.id)
            const name  = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined

            push({
                title: `${label ? `${label} (${name})` : name} edited a message`,
                body: preview(message.content, message.attachments?.[0]?.filename),
                icon,
                onClick: () => jumpTo(guildId, message.channel_id, message.id),
            })
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
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined
            const body  = settings.store.showPreview && msg.content
                ? `"${trunc(msg.content, settings.store.previewLen)}"`
                : "message was deleted"

            push({
                title: `${label ? `${label} (${name})` : name} deleted a message`,
                body, icon,
                onClick: () => jumpTo(evt.guildId, msg!.channel_id, msg!.id),
            })
        },

        TYPING_START(evt: TypingEvent) {
            if (!evt?.userId || !evt?.channelId) return
            if (!featureOn(settings, evt.userId, "typing", "globalTyping")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === evt.channelId) return

            const u = UserStore.getUser(evt.userId)
            if (!u) return

            const label = getWatchedUser(settings, evt.userId)?.nick
            const ch    = ChannelStore.getChannel(evt.channelId)
            const icon  = safeAvatar(u.id, (u as any).avatar)

            push({
                title: `${label ? `${label} (${displayName(u)})` : displayName(u)} is typing…`,
                body: ch?.name ? `in #${ch.name}` : "click to jump",
                icon,
                onClick: () => jumpTo(ch?.guild_id, evt.channelId),
            })
        },

        // websocket pushes username/avatar changes instantly, good for fast detection
        USER_UPDATE(evt: { user: any }) {
            if (!evt?.user?.id || !isWatched(settings, evt.user.id)) return
            const old = profileCache[evt.user.id]
            if (!old) return
            checkProfile(evt.user.id, { ...old, user: { ...old.user, ...camelize(evt.user) } })
        },

        // fires when discord fetches someone's profile (opening their card, visiting profile etc)
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
                if (prev === (channelId ?? null)) continue  // no actual change

                const u     = UserStore.getUser(userId)
                const label = getWatchedUser(settings, userId)?.nick
                const dn    = label ? `${label} (${displayName(u)})` : displayName(u)
                const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined

                if (!prev && channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    push({ title: `${dn} joined voice`, body: ch ? `#${ch.name}` : "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                } else if (prev && !channelId) {
                    push({ title: `${dn} left voice`, body: "disconnected", icon, onClick: () => openUserProfile(userId) })
                } else if (prev && channelId && prev !== channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    push({ title: `${dn} moved vc`, body: ch ? `now in #${ch.name}` : "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                }
            }
        },

        PRESENCE_UPDATES(evt: PresenceEvent) {
            for (const update of evt.updates ?? []) {
                const { id } = update.user
                if (!isWatched(settings, id)) continue

                const u     = UserStore.getUser(id)
                const label = getWatchedUser(settings, id)?.nick
                const dn    = label ? `${label} (${displayName(u)})` : displayName(u)
                const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined

                // status tracking
                if (featureOn(settings, id, "status", "globalStatus")) {
                    const prev = statusCache[id]
                    statusCache[id] = update.status
                    if (prev && prev !== update.status) {
                        push({
                            title: `${dn} is now ${update.status} ${STATUS_EMOJI[update.status] ?? ""}`,
                            body: `was: ${prev} ${STATUS_EMOJI[prev] ?? ""}`,
                            icon,
                            onClick: () => openUserProfile(id),
                        })
                    }
                }

                // activity tracking (playing/listening/watching/competing)
                // type 4 = custom status, we skip that one
                if (featureOn(settings, id, "activity", "globalActivity")) {
                    const ACT_VERB: Record<number, string> = {
                        0: "playing",
                        2: "listening to",
                        3: "watching",
                        5: "competing in",
                    }

                    const act    = (update.activities ?? []).find((a: any) => a.type !== 4) ?? null
                    const actKey = act ? `${act.type}:${act.name}` : null
                    const prevKey = activityCache[id] ?? null
                    activityCache[id] = actKey

                    if (prevKey !== actKey && activityCache[id] !== undefined) {
                        if (act) {
                            const verb   = ACT_VERB[act.type] ?? "doing"
                            const detail = act.details ? ` — ${act.details}` : ""
                            push({
                                title: `${dn} is ${verb} ${act.name}`,
                                body: `${act.state ?? ""}${detail}`.trim() || `${verb} ${act.name}`,
                                icon,
                                onClick: () => openUserProfile(id),
                            })
                        } else if (prevKey) {
                            push({
                                title: `${dn} stopped their activity`,
                                body: "no longer active",
                                icon,
                                onClick: () => openUserProfile(id),
                            })
                        }
                    }
                }
            }
        },

        // fires when someone joins a server you're in
        GUILD_MEMBER_ADD(evt: GuildMemberEvent) {
            if (!evt?.user?.id || !isWatched(settings, evt.user.id)) return
            if (!featureOn(settings, evt.user.id, "joins", "globalJoins")) return

            const u     = UserStore.getUser(evt.user.id)
            const label = getWatchedUser(settings, evt.user.id)?.nick
            const dn    = label ? `${label} (${displayName(u ?? evt.user)})` : displayName(u ?? evt.user)
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : safeAvatar(evt.user.id, evt.user.avatar)
            const guild = (findByProps("getGuild")?.getGuild(evt.guildId) as any)

            push({
                title: `${dn} joined a server`,
                body: guild?.name ?? "click to view",
                icon,
                onClick: () => jumpTo(evt.guildId),
            })
        },

        // fires when someone leaves/gets kicked/banned from a server you're in
        GUILD_MEMBER_REMOVE(evt: GuildMemberEvent) {
            if (!evt?.user?.id || !isWatched(settings, evt.user.id)) return
            if (!featureOn(settings, evt.user.id, "joins", "globalJoins")) return

            const u     = UserStore.getUser(evt.user.id)
            const label = getWatchedUser(settings, evt.user.id)?.nick
            const dn    = label ? `${label} (${displayName(u ?? evt.user)})` : displayName(u ?? evt.user)
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : safeAvatar(evt.user.id, evt.user.avatar)
            const guild = (findByProps("getGuild")?.getGuild(evt.guildId) as any)

            push({
                title: `${dn} left a server`,
                body: guild?.name ?? "click to view",
                icon,
                onClick: () => openUserProfile(evt.user.id),
            })
        },
    },

    async start() {
        addContextMenuPatch("user-context", userContextPatch)

        if (typeof Notification !== "undefined" && Notification.permission === "default") {
            Notification.requestPermission()
        }

        // pre-fetch everyone's profile so the first poll doesn't spam false positives
        for (const wu of getWatchlist(settings)) {
            try {
                const { body } = await RestAPI.get({
                    url: `/users/${wu.id}/profile`,
                    query: { with_mutual_guilds: false, with_mutual_friends_count: false },
                })
                profileCache[wu.id] = camelize(body)
            } catch { }
        }

        pollTimer = setInterval(pollProfiles, 5 * 60 * 1000)

        tryLoadLoggedMsgs().then(m => {
            if (m) log.info("hooked into message logger")
            else   log.warn("message logger not found — delete content won't be available")
        })
    },

    stop() {
        removeContextMenuPatch("user-context", userContextPatch)
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        for (const k in profileCache)  delete profileCache[k]
        for (const k in vcCache)       delete vcCache[k]
        for (const k in statusCache)   delete statusCache[k]
        for (const k in activityCache) delete activityCache[k]
        loggedMsgs = null
    },

    async watchUser(id: string) {
        addUser(settings, id)
        const u = UserStore.getUser(id)
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `now watching ${displayName(u)}`, id: Toasts.genId() })
        try {
            const { body } = await RestAPI.get({
                url: `/users/${id}/profile`,
                query: { with_mutual_guilds: false, with_mutual_friends_count: false },
            })
            profileCache[id] = camelize(body)
        } catch { }
    },

    unwatchUser(id: string) {
        const u = UserStore.getUser(id)
        removeUser(settings, id)
        delete profileCache[id]; delete vcCache[id]; delete statusCache[id]; delete activityCache[id]
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `stopped watching ${displayName(u)}`, id: Toasts.genId() })
    },
})

// right-click context menu patch
const userContextPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.user) return
    if (props.user.id === UserStore.getCurrentUser()?.id) return  // don't watch yourself lol
    if (children.some((c: any) => c?.props?.id === "userradar-group")) return

    const { id } = props.user
    const watching = isWatched(settings, id)

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuGroup id="userradar-group">
            <Menu.MenuItem
                id="userradar-toggle"
                label={watching ? "👁 stop watching" : "👁 watch user"}
                action={() => {
                    const p = Vencord.Plugins.plugins["UserRadar"] as any
                    watching ? p.unwatchUser(id) : p.watchUser(id)
                }}
            />
            {watching && (
                <Menu.MenuItem
                    id="userradar-manage"
                    label="⚙ manage watchlist"
                    action={() => openModal(p => <WatchlistModal modalProps={p} />)}
                />
            )}
        </Menu.MenuGroup>
    )
}
