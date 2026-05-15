// index.tsx
// k1ng_op — userradar
// basically a stalker plugin lol, tracks people and notifies you when they do stuff
// messages, edits, deletes, typing, profile/avatar, voice, status, activity, boosts, server joins

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

// runtime caches — wiped when plugin stops
const profileCache:  Record<string, any>           = {}
const vcCache:       Record<string, string | null>  = {}
const statusCache:   Record<string, string>          = {}
// activityCache stores undefined = never seen, null = no activity, string = has activity
// this distinction matters so we don't fire a notif on the very first presence update
const activityCache: Record<string, string | null | undefined> = {}
// guildCache tracks which servers a watched user is already in
// GUILD_MEMBER_ADD fires on discord reconnect/re-sync for users already in the server
// so we snapshot their guilds on start and skip any add event for guilds already in cache
const guildCache: Record<string, Set<string>> = {}  // uid -> Set<guildId>

let loggedMsgs: Record<string, Message> | null = null
let pollTimer:  ReturnType<typeof setInterval> | null = null

// hook into vc-message-logger-enhanced for deleted message content
// if not installed, deletes just say "message was deleted"
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

// -- settings --

const settings = definePluginSettings({
    watchlist:          { type: OptionType.STRING,  hidden: true,  default: "[]",    description: "watchlist json — managed by the ui, don't touch" },
    globalMsgs:         { type: OptionType.BOOLEAN, default: true,                   description: "messages" },
    globalEdits:        { type: OptionType.BOOLEAN, default: true,                   description: "message edits" },
    globalDeletes:      { type: OptionType.BOOLEAN, default: true,                   description: "message deletes (content needs vc-message-logger-enhanced)" },
    globalTyping:       { type: OptionType.BOOLEAN, default: true,                   description: "typing (works in servers and dms)" },
    globalProfile:      { type: OptionType.BOOLEAN, default: true,                   description: "profile changes (bio, banner, username, colors)" },
    globalAvatar:       { type: OptionType.BOOLEAN, default: true,                   description: "avatar changes" },
    globalVoice:        { type: OptionType.BOOLEAN, default: true,                   description: "voice joins / leaves / moves" },
    globalStatus:       { type: OptionType.BOOLEAN, default: false,                  description: "status changes — spammy, off by default" },
    globalBoosts:       { type: OptionType.BOOLEAN, default: true,                   description: "server boosts" },
    globalActivity:     { type: OptionType.BOOLEAN, default: false,                  description: "activity changes (playing, listening, watching) — very spammy, off by default" },
    globalJoins:        { type: OptionType.BOOLEAN, default: true,                   description: "server joins / leaves (only servers you're in)" },
    showPreview:        { type: OptionType.BOOLEAN, default: true,                   description: "show message content in notifications" },
    previewLen:         { type: OptionType.NUMBER,  default: 120,                    description: "max chars in preview (0 = no limit)" },
    quietHours:         { type: OptionType.BOOLEAN, default: false,                  description: "silence all notifications during certain hours" },
    quietStart:         { type: OptionType.STRING,  default: "23:00",                description: "quiet hours start (24h, e.g. 23:00)" },
    quietEnd:           { type: OptionType.STRING,  default: "07:00",                description: "quiet hours end (24h, e.g. 07:00)" },
    skipCurrentChannel: { type: OptionType.BOOLEAN, default: true,                   description: "skip notification if you're already in that channel" },
    debugLog:           { type: OptionType.BOOLEAN, default: false,                  description: "log all events to console" },
})

// -- notif helpers --

function trunc(s: string, max: number) {
    return max > 0 && s.length > max ? s.slice(0, max) + "…" : s
}

function msgPreview(content: string, filename?: string) {
    if (!settings.store.showPreview) return "click to jump"
    return trunc(content || filename || "click to jump", settings.store.previewLen)
}

function jumpTo(guildId?: string, channelId?: string, msgId?: string) {
    if (guildId)   findByProps("transitionToGuildSync")?.transitionToGuildSync(guildId)
    if (channelId) findByProps("selectChannel")?.selectChannel({ guildId: guildId ?? "@me", channelId, messageId: msgId })
}

function notify(opts: { title: string; body: string; icon?: string; onClick?: () => void }) {
    if (inQuietHours(settings)) return
    if (settings.store.debugLog) log.info(`[notif] ${opts.title} — ${opts.body}`)

    if (document.hasFocus()) {
        Notifications.showNotification({ title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick })
    } else {
        try {
            const n = new window.Notification(opts.title, { body: opts.body, icon: opts.icon })
            if (opts.onClick) n.onclick = () => { window.focus(); opts.onClick!() }
        } catch {
            Notifications.showNotification({ title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick })
        }
    }
}

// -- avatar helpers --
// manually building cdn urls because getAvatarURL() signature keeps changing

function avatarUrl(id: string, hash?: string | null, size = 80): string {
    try {
        if (hash) return `https://cdn.discordapp.com/avatars/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=${size}`
        let i = 0
        try { i = Number(BigInt(id) % BigInt(6)) } catch { i = parseInt(id.slice(-4), 10) % 6 || 0 }
        return `https://cdn.discordapp.com/embed/avatars/${i}.png`
    } catch { return "https://cdn.discordapp.com/embed/avatars/0.png" }
}

function safeAvatar(id: string, hash?: string | null, size = 80) { return avatarUrl(id, hash, size) }

function bannerUrl(id: string, hash?: string | null): string | null {
    if (!hash) return null
    return `https://cdn.discordapp.com/banners/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=480`
}

function hexColor(n?: number | null): string | null {
    if (n == null) return null
    try { return "#" + n.toString(16).padStart(6, "0") } catch { return null }
}

const FALLBACK_AV = "https://cdn.discordapp.com/embed/avatars/0.png"

// -- profile diffing --
//
// the accent color / banner color false positive issue:
// discord sends these as null from /profile endpoint, 0 from websocket USER_UPDATE,
// and sometimes undefined if the user never set one
// all three mean "no color" but they'd fail a !== check
// normalizing to null before comparing fixes it

function normColor(v: any): string | null {
    if (v == null || v === 0) return null
    return String(v)
}

const PROFILE_TEXT   = ["username", "globalName", "bio", "banner"] as const
const PROFILE_COLORS = ["bannerColor", "accentColor"] as const
const FIELD_NAME: Record<string, string> = {
    username: "username", globalName: "display name",
    bio: "bio", banner: "banner",
    bannerColor: "banner color", accentColor: "accent color",
}

function checkProfileChanged(uid: string, fresh: any) {
    if (!isWatched(settings, uid)) return

    const old = profileCache[uid]
    if (!old) {
        profileCache[uid] = fresh
        return  // first time, just save baseline
    }

    // avatar is its own separate notification with its own toggle
    if (fresh.user?.avatar !== old.user?.avatar) {
        if (featureOn(settings, uid, "avatar", "globalAvatar")) {
            const name  = displayName(fresh.user)
            const label = getWatchedUser(settings, uid)?.nick
            const dn    = label ? `${label} (${name})` : name
            notify({
                title: `${dn} changed their avatar`,
                body: "click to see new pfp",
                icon: fresh.user?.avatar
                    ? `https://cdn.discordapp.com/avatars/${uid}/${fresh.user.avatar}.webp?size=128`
                    : undefined,
                onClick: () => openUserProfile(uid),
            })
        }
        // always update avatar in cache regardless of notif, keeps future diffs clean
        profileCache[uid] = { ...profileCache[uid], user: { ...profileCache[uid].user, avatar: fresh.user?.avatar } }
    }

    const changed: string[] = []
    for (const f of PROFILE_TEXT) {
        if ((fresh.user?.[f] ?? null) !== (old.user?.[f] ?? null)) changed.push(f)
    }
    for (const f of PROFILE_COLORS) {
        // normalize colors before comparing to avoid null/0/undefined false positives
        if (normColor(fresh.user?.[f]) !== normColor(old.user?.[f])) changed.push(f)
    }

    if (changed.length > 0 && featureOn(settings, uid, "profile", "globalProfile")) {
        const u     = UserStore.getUser(uid)
        const name  = displayName(fresh.user)
        const label = getWatchedUser(settings, uid)?.nick
        const dn    = label ? `${label} (${name})` : name
        notify({
            title: `${dn} updated their profile`,
            body: changed.map(f => FIELD_NAME[f] ?? f).join(", "),
            icon: u ? safeAvatar(u.id, (u as any).avatar) : undefined,
            onClick: () => openUserProfile(uid),
        })
    }

    profileCache[uid] = fresh
}

// poll bio/banner every 5 mins
// discord doesn't push those fields over websocket, this is the only way to catch them
async function pollProfiles() {
    const list = getWatchlist(settings)
    if (!list.length) return
    for (const wu of list) {
        try {
            const { body } = await RestAPI.get({
                url: `/users/${wu.id}/profile`,
                query: { with_mutual_guilds: false, with_mutual_friends_count: false },
            })
            checkProfileChanged(wu.id, camelize(body))
        } catch { }
        await new Promise(r => setTimeout(r, 1500))
    }
}

// -- modal --

const STYLE_ID = "ur-s9"
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement("style")
    s.id = STYLE_ID
    s.textContent = `
        @keyframes ur-spin { to { transform:rotate(360deg) } }
        .ur-spin { display:inline-block;width:14px;height:14px;border-radius:50%;
            border:2.5px solid rgba(255,255,255,.15);border-top-color:#fff;
            animation:ur-spin .55s linear infinite;vertical-align:middle; }
        @keyframes ur-fade-in { from { opacity:0;transform:translateY(-4px) } to { opacity:1;transform:translateY(0) } }
        .ur-fade-in { animation:ur-fade-in .2s cubic-bezier(.4,0,.2,1) forwards; }
        .ur-expand { display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s cubic-bezier(.4,0,.2,1); }
        .ur-expand.open { grid-template-rows:1fr; }
        .ur-expand > div { overflow:hidden; }
        .ur-row-hover:hover { background:rgba(255,255,255,0.04); }
        .ur-scrollbar::-webkit-scrollbar { width:8px; }
        .ur-scrollbar::-webkit-scrollbar-track { background:transparent; }
        .ur-scrollbar::-webkit-scrollbar-thumb { background:#3f4147;border-radius:4px; }
    `
    document.head.appendChild(s)
}

const C = {
    bg1:         "#1e1f22",
    bg2:         "#2b2d31",
    bg3:         "#313338",
    bgEl:        "#404249",
    border:      "#3f4147",
    hov:         "rgba(255,255,255,0.04)",
    header:      "#f2f3f5",
    subheader:   "#b5bac1",
    text:        "#dbdee1",
    muted:       "#949ba4",
    danger:      "#fa777c",
    brand:       "#5865f2",
    brandLight:  "#949cf4",
    brandGrad:   "linear-gradient(135deg,#5865f2 0%,#949cf4 100%)",
    green:       "#248046",
    red:         "#da373c",
    white:       "#ffffff",
} as const

// svg icons — functions so they don't cause module-level jsx issues
const ico = {
    search:   () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
    check:    () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    x:        () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    chevron:  () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>,
    trash:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    copy:     () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="2"/></svg>,
    external: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
    sortAz:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h12M3 12h8M3 18h4M16 8l4-4 4 4M20 4v16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    sortDate: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
    eye:      () => <svg width="20" height="20" viewBox="0 0 24 24" fill={C.white}><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>,
    ghost:    () => <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity=".25"><path d="M12 2a9 9 0 0 0-9 9v7c0 1.66 1.34 3 3 3h3v-4h6v4h3c1.66 0 3-1.34 3-3v-7a9 9 0 0 0-9-9zm-3 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>,
    msg:      () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2 22V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6l-4 4z"/></svg>,
    edit:     () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 20h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    del:      () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M15 3v-1a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v1H3v2h2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5h2V3h-6zm-4-1h2v1h-2V2zm-2 5h2v9h-2V7zm4 0h2v9h-2V7z"/></svg>,
    typing:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="20" cy="12" r="2"/></svg>,
    profile:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="2"/></svg>,
    avatar:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="10" r="3" stroke="currentColor" strokeWidth="2"/><path d="M7 21c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke="currentColor" strokeWidth="2"/></svg>,
    voice:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>,
    status:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity=".3"/><circle cx="12" cy="12" r="5"/></svg>,
    boosts:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6-4.8-6 4.8 2.4-7.2-6-4.8h7.6z"/></svg>,
    activity: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>,
    joins:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2"/><circle cx="8.5" cy="7" r="4" stroke="currentColor" strokeWidth="2"/><path d="M20 8v6M23 11h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
}

// context menu icons — module-level so they don't glitch on re-render
const CtxEyeIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
    </svg>
)
const CtxEyeOffIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
)
const CtxGearIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
)

// discord's own Switch import is unreliable, just making my own
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
    return (
        <div
            role="switch" aria-checked={on}
            onClick={() => onChange(!on)}
            style={{
                width: 36, height: 22, borderRadius: 11, flexShrink: 0,
                background: on ? C.green : "#4e5058",
                cursor: "pointer", position: "relative",
                transition: "background 150ms ease",
            }}
        >
            <div style={{
                position: "absolute", top: 2, left: on ? 16 : 2,
                width: 18, height: 18, borderRadius: "50%",
                background: C.white, boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
                transition: "left 150ms cubic-bezier(0.4,0,0.2,1)",
            }} />
        </div>
    )
}

// add user — step 1: type id, step 2: preview + confirm
type LookupStage =
    | { s: "idle" }
    | { s: "loading" }
    | { s: "done"; user: any; av: string }
    | { s: "err"; msg: string }

function AddUserInput({ rawId, setRawId, hasErr, lk, setLk, doLookup }: {
    rawId: string
    setRawId: (v: string) => void
    hasErr: boolean
    lk: LookupStage
    setLk: (v: LookupStage) => void
    doLookup: () => void
}) {
    const [focused, setFocused] = React.useState(false)
    const borderColor = hasErr ? C.red : focused ? C.brand : C.border

    return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
                <input
                    placeholder="paste a discord user id"
                    value={rawId}
                    onChange={(e) => { setRawId(e.target.value); if (hasErr) setLk({ s: "idle" }) }}
                    onKeyDown={(e) => { if (e.key === "Enter") doLookup() }}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    autoFocus
                    style={{
                        background: C.bg1,
                        borderRadius: 20,
                        border: `1px solid ${borderColor}`,
                        height: 40,
                        boxSizing: "border-box",
                        padding: "0 14px",
                        transition: "border-color 150ms ease",
                        width: "100%",
                        fontSize: 14,
                        color: C.text,
                        outline: "none",
                        fontFamily: "inherit",
                    }}
                />
                <div style={{ fontSize: 11, color: hasErr ? C.danger : C.muted, marginTop: 5, display: "flex", alignItems: "center", gap: 4 }}>
                    {hasErr ? <ico.x /> : null}
                    {hasErr ? (lk as any).msg : "developer mode → right-click user → copy user id"}
                </div>
            </div>
            <button
                onClick={doLookup}
                disabled={lk.s === "loading"}
                style={{
                    borderRadius: 20,
                    height: 40,
                    boxSizing: "border-box",
                    padding: "0 20px",
                    background: lk.s === "loading" ? "#4752c4" : C.brand,
                    color: "#fff",
                    border: "none",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: lk.s === "loading" ? "not-allowed" : "pointer",
                    flexShrink: 0,
                    fontFamily: "inherit",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: lk.s === "loading" ? 0.7 : 1,
                }}
            >
                {lk.s === "loading" ? <><span className="ur-spin" style={{ marginRight: 6 }} />looking…</> : "look up"}
            </button>
        </div>
    )
}

function AddLabelInput({ label, setLabel, doAdd }: {
    label: string
    setLabel: (v: string) => void
    doAdd: () => void
}) {
    const [focused, setFocused] = React.useState(false)
    return (
        <input
            placeholder='e.g. "bestie", "the rat", "ex"'
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doAdd() }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoFocus
            style={{
                background: C.bg1,
                borderRadius: 20,
                border: `1px solid ${focused ? C.brand : C.border}`,
                height: 40,
                boxSizing: "border-box",
                padding: "0 14px",
                transition: "border-color 150ms ease",
                width: "100%",
                fontSize: 14,
                color: C.text,
                outline: "none",
                fontFamily: "inherit",
                marginBottom: 14,
            }}
        />
    )
}

function AddUserSection({ onAdded }: { onAdded: () => void }) {
    const [rawId, setRawId] = React.useState("")
    const [label, setLabel] = React.useState("")
    const [lk, setLk]       = React.useState<LookupStage>({ s: "idle" })

    const cleanId = rawId.trim().replace(/\D/g, "")
    const hasErr  = lk.s === "err"

    const doLookup = () => {
        if (!cleanId)                                    return setLk({ s: "err", msg: "enter a user id first" })
        if (cleanId.length < 17 || cleanId.length > 20) return setLk({ s: "err", msg: "discord ids are 17-20 digits" })
        if (isWatched(settings, cleanId))                return setLk({ s: "err", msg: "already on your watchlist" })

        setLk({ s: "loading" })
        RestAPI.get({
            url: `/users/${cleanId}/profile`,
            query: { with_mutual_guilds: false, with_mutual_friends_count: false },
        }).then((res: any) => {
            const d = camelize(res.body)
            setLk({ s: "done", user: d.user, av: avatarUrl(d.user.id, d.user.avatar, 64) })
        }).catch((e: any) => {
            const code = e?.status ?? e?.response?.status
            setLk({
                s: "err",
                msg: code === 404 ? "user not found"
                   : code === 403 ? "profile is private (no shared server) — you can still add by id"
                   : `request failed${code ? ` (${code})` : ""}`,
            })
        })
    }

    const doAdd = () => {
        if (lk.s !== "done") return
        addUser(settings, cleanId, label.trim())
        setRawId(""); setLabel(""); setLk({ s: "idle" })
        onAdded()
    }

    return (
        <div className="ur-fade-in">
            <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: C.subheader, marginBottom: 12 }}>
                add user
            </div>

            {lk.s !== "done" && (
                <AddUserInput
                    rawId={rawId}
                    setRawId={setRawId}
                    hasErr={hasErr}
                    lk={lk}
                    setLk={setLk}
                    doLookup={doLookup}
                />
            )}

            {lk.s === "done" && (
                <div className="ur-fade-in">
                    {/* preview card */}
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "12px 16px",
                        background: C.bg1,
                        borderRadius: 20,
                        border: `1px solid ${C.border}`,
                        marginBottom: 14,
                    }}>
                        <img
                            src={lk.av}
                            style={{ width: 48, height: 48, borderRadius: "50%", flexShrink: 0 }}
                            onError={(e: any) => { e.target.src = FALLBACK_AV }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 700, color: C.header }}>
                                {lk.user.globalName || lk.user.username}
                            </div>
                            {lk.user.globalName && (
                                <div style={{ fontSize: 13, color: C.muted, marginTop: 1 }}>
                                    @{lk.user.username}
                                </div>
                            )}
                            <div style={{ fontSize: 11, color: C.muted, marginTop: 3, fontFamily: "monospace", opacity: .6 }}>
                                {lk.user.id}
                            </div>
                        </div>
                        <div style={{
                            width: 28,
                            height: 28,
                            borderRadius: "50%",
                            background: "rgba(36,128,70,0.15)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                        }}>
                            <div style={{ color: C.green }}><ico.check /></div>
                        </div>
                    </div>

                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: C.subheader, marginBottom: 6 }}>
                        label <span style={{ fontWeight: 500, color: C.muted, textTransform: "none" }}>(optional, only you see this)</span>
                    </div>
                    <AddLabelInput label={label} setLabel={setLabel} doAdd={doAdd} />

                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            onClick={doAdd}
                            style={{
                                flex: 1,
                                borderRadius: 20,
                                height: 40,
                                boxSizing: "border-box",
                                padding: "0 20px",
                                background: C.green,
                                color: "#fff",
                                border: "none",
                                fontSize: 14,
                                fontWeight: 600,
                                cursor: "pointer",
                                fontFamily: "inherit",
                                transition: "background 150ms ease",
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = "#2d9c5a" }}
                            onMouseLeave={e => { e.currentTarget.style.background = C.green }}
                        >
                            add to watchlist
                        </button>
                        <button
                            onClick={() => { setLk({ s: "idle" }); setLabel("") }}
                            style={{
                                borderRadius: 20,
                                height: 40,
                                boxSizing: "border-box",
                                padding: "0 18px",
                                background: "transparent",
                                color: C.text,
                                border: `1px solid ${C.border}`,
                                fontSize: 14,
                                fontWeight: 500,
                                cursor: "pointer",
                                fontFamily: "inherit",
                                transition: "background 150ms ease, border-color 150ms ease",
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.background = "rgba(255,255,255,0.05)"
                                e.currentTarget.style.borderColor = C.bgEl
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.background = "transparent"
                                e.currentTarget.style.borderColor = C.border
                            }}
                        >
                            cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

const OV_ROWS = [
    { label: "messages",  key: "msgs",     gk: "globalMsgs",     Icon: ico.msg,      desc: "new messages" },
    { label: "edits",     key: "edits",    gk: "globalEdits",    Icon: ico.edit,     desc: "message edits" },
    { label: "deletes",   key: "deletes",  gk: "globalDeletes",  Icon: ico.del,      desc: "deleted messages" },
    { label: "typing",    key: "typing",   gk: "globalTyping",   Icon: ico.typing,   desc: "typing indicator" },
    { label: "profile",   key: "profile",  gk: "globalProfile",  Icon: ico.profile,  desc: "bio, banner, username" },
    { label: "avatar",    key: "avatar",   gk: "globalAvatar",   Icon: ico.avatar,   desc: "profile picture" },
    { label: "voice",     key: "voice",    gk: "globalVoice",    Icon: ico.voice,    desc: "vc joins / leaves" },
    { label: "status",    key: "status",   gk: "globalStatus",   Icon: ico.status,   desc: "online status" },
    { label: "boosts",    key: "boosts",   gk: "globalBoosts",   Icon: ico.boosts,   desc: "server boosts" },
    { label: "activity",  key: "activity", gk: "globalActivity", Icon: ico.activity, desc: "games, spotify, etc." },
    { label: "joins",     key: "joins",    gk: "globalJoins",    Icon: ico.joins,    desc: "server joins / leaves" },
] as const

function LabelInput({ nick, setNick, saveNick }: { nick: string; setNick: (v: string) => void; saveNick: () => void }) {
    const [focused, setFocused] = React.useState(false)
    return (
        <input
            placeholder="label"
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            onBlur={() => { setFocused(false); saveNick() }}
            onFocus={() => setFocused(true)}
            onKeyDown={(e) => { if (e.key === "Enter") { setFocused(false); saveNick() } }}
            style={{
                background: C.bg1,
                borderRadius: 20,
                border: `1px solid ${focused ? C.brand : C.border}`,
                height: 26,
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                padding: "0 10px",
                fontSize: 12,
                width: "100%",
                margin: 0,
                color: C.text,
                outline: "none",
                transition: "border-color 150ms ease",
                fontFamily: "inherit",
            }}
        />
    )
}

function SearchInput({ query, setQuery }: { query: string; setQuery: (v: string) => void }) {
    const [focused, setFocused] = React.useState(false)
    const inputRef = React.useRef<HTMLInputElement>(null)
    return (
        <div
            onClick={() => inputRef.current?.focus()}
            style={{
                display: "flex", alignItems: "center", gap: 6,
                width: 160,
                background: C.bg1,
                borderRadius: 20,
                border: `1px solid ${focused ? C.brand : C.border}`,
                padding: "0 10px",
                height: 28,
                boxSizing: "border-box",
                transition: "border-color 150ms ease",
                cursor: "text",
            }}
        >
            <div style={{ color: C.muted, display: "flex", alignItems: "center", flexShrink: 0 }}><ico.search /></div>
            <input
                ref={inputRef}
                placeholder="search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => setFocused(false)}
                onFocus={() => setFocused(true)}
                style={{
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    flex: 1,
                    fontSize: 13,
                    padding: 0,
                    margin: 0,
                    height: "100%",
                    minHeight: "auto",
                    color: C.text,
                    fontFamily: "inherit",
                }}
            />
            {query && (
                <div
                    role="button"
                    onClick={(e) => { e.stopPropagation(); setQuery("") }}
                    style={{ color: C.muted, cursor: "pointer", display: "flex", alignItems: "center", lineHeight: 1, flexShrink: 0 }}
                >
                    <ico.x />
                </div>
            )}
        </div>
    )
}

function WatchedRow({ user, refresh, onRemove }: { user: WatchedUser; refresh: () => void; onRemove: () => void }) {
    const [nick,     setNick] = React.useState(user.nick || "")
    const [expanded, setExp]  = React.useState(false)
    const [copied,   setCopy] = React.useState(false)

    const du   = UserStore.getUser(user.id)
    const name = displayName(du) || user.id
    const av   = du ? avatarUrl(du.id, (du as any).avatar, 64) : avatarUrl(user.id, null, 64)

    const saveNick = () => { patchUser(settings, user.id, { nick: nick || "" }); refresh() }
    const setOv = (key: keyof WatchedUser["overrides"], val: boolean | null) => {
        patchUser(settings, user.id, { overrides: { ...user.overrides, [key]: val } })
        refresh()
    }

    const copyId = () => {
        navigator.clipboard.writeText(user.id)
        setCopy(true)
        setTimeout(() => setCopy(false), 1200)
    }

    return (
        <div style={{ background: C.bg2, borderRadius: 20, marginBottom: 8, border: `1px solid ${C.border}`, overflow: "hidden" }}>
            {/* main row */}
            <div className="ur-row-hover" onClick={() => setExp(v => !v)} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", cursor: "pointer",
                borderRadius: expanded ? "20px 20px 0 0" : 20, transition: "background 100ms",
            }}>
                <img src={av} style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0 }}
                    onError={(e: any) => { e.target.src = FALLBACK_AV }} />

                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: C.header }}>{name}</span>
                        {user.nick && (
                            <span style={{ background: C.brandGrad, color: C.white, fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                                {user.nick}
                            </span>
                        )}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 3, display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontFamily: "monospace", opacity: .7 }}>{user.id}</span>
                        <span>·</span>
                        <span>added {new Date(user.addedAt).toLocaleDateString()}</span>
                    </div>
                </div>

                {/* label input */}
                <div onClick={(e: any) => e.stopPropagation()} style={{ width: 80, flexShrink: 0 }}>
                    <LabelInput nick={nick} setNick={setNick} saveNick={saveNick} />
                </div>

                {/* chevron */}
                <div style={{ color: C.muted, display: "flex", alignItems: "center", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 200ms cubic-bezier(.4,0,.2,1)" }}>
                    <ico.chevron />
                </div>

                {/* action buttons */}
                <div onClick={(e: any) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    {[
                        { title: "copy id",       icon: copied ? <ico.check /> : <ico.copy />, color: copied ? C.green : C.muted, action: copyId },
                        { title: "open profile",  icon: <ico.external />,                       color: C.muted,                   action: () => openUserProfile(user.id) },
                        { title: "remove",        icon: <ico.trash />,                          color: C.red,                     action: onRemove },
                    ].map(btn => (
                        <div key={btn.title} role="button" tabIndex={0} title={btn.title}
                            onClick={btn.action}
                            onKeyDown={(e: any) => { if (e.key === "Enter") btn.action() }}
                            style={{ color: btn.color, cursor: "pointer", padding: 6, borderRadius: 6, display: "flex", alignItems: "center", transition: "background 100ms" }}
                            onMouseEnter={e => (e.currentTarget.style.background = btn.title === "remove" ? "rgba(218,55,60,0.12)" : C.hov)}
                            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                        >
                            {btn.icon}
                        </div>
                    ))}
                </div>
            </div>

            {/* override panel — css grid animation */}
            <div className={`ur-expand${expanded ? " open" : ""}`}>
                <div>
                    <div style={{ padding: "10px 16px 14px", borderTop: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: C.subheader, marginBottom: 10 }}>
                            per-user overrides
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            {OV_ROWS.map(row => {
                                const isOn = featureOn(settings, user.id, row.key as any, row.gk)
                                const isOv = (user.overrides as any)[row.key] !== null && (user.overrides as any)[row.key] !== undefined
                                return (
                                    <div key={row.key}
                                        onClick={() => setOv(row.key as any, !isOn)}
                                        style={{
                                            background: C.bg1,
                                            borderRadius: 14,
                                            border: `1px solid ${isOv ? C.brand : C.border}`,
                                            padding: "10px 12px",
                                            cursor: "pointer",
                                            transition: "border-color 150ms ease, background 150ms ease",
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 10,
                                        }}
                                        onMouseEnter={e => {
                                            e.currentTarget.style.background = "rgba(255,255,255,0.03)"
                                            e.currentTarget.style.borderColor = isOv ? C.brandLight : C.bgEl
                                        }}
                                        onMouseLeave={e => {
                                            e.currentTarget.style.background = C.bg1
                                            e.currentTarget.style.borderColor = isOv ? C.brand : C.border
                                        }}
                                    >
                                        <div style={{ color: C.muted, display: "flex", alignItems: "center", flexShrink: 0 }}>
                                            <row.Icon />
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 13, color: C.text, fontWeight: 600, userSelect: "none", lineHeight: 1.3 }}>
                                                {row.label}
                                                {isOv && (
                                                    <span style={{ color: C.brandLight, marginLeft: 5, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 }}>
                                                        custom
                                                    </span>
                                                )}
                                            </div>
                                            <div style={{ fontSize: 11, color: C.muted, userSelect: "none", marginTop: 2, lineHeight: 1.2 }}>
                                                {row.desc}
                                            </div>
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                            <Toggle on={isOn} onChange={v => setOv(row.key as any, v)} />
                                            {isOv && (
                                                <div role="button" tabIndex={0} title="reset to global"
                                                    onClick={(e: any) => { e.stopPropagation(); setOv(row.key as any, null) }}
                                                    onKeyDown={(e: any) => { if (e.key === "Enter") { e.stopPropagation(); setOv(row.key as any, null) } }}
                                                    style={{ color: C.muted, cursor: "pointer", fontSize: 11, padding: "2px 4px", borderRadius: 4, userSelect: "none" }}
                                                    onMouseEnter={e => (e.currentTarget.style.background = C.hov)}
                                                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                                                >
                                                    ↩
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

type SortMode = "az" | "date"

function WatchlistModal({ modalProps }: { modalProps: any }) {
    React.useEffect(() => { injectStyles() }, [])

    const [users, setUsers] = React.useState<WatchedUser[]>(() => { try { return getWatchlist(settings) } catch { return [] } })
    const [query, setQuery] = React.useState("")
    const [sort,  setSort]  = React.useState<SortMode>("date")

    const refresh = () => { try { setUsers(getWatchlist(settings)) } catch { setUsers([]) } }

    const shown = React.useMemo(() => {
        let list = users.filter(u => {
            if (!query.trim()) return true
            const q  = query.toLowerCase()
            const du = UserStore.getUser(u.id)
            return [displayName(du), u.nick ?? "", u.id].join(" ").toLowerCase().includes(q)
        })
        return sort === "az"
            ? [...list].sort((a, b) => (displayName(UserStore.getUser(a.id)) || a.id).localeCompare(displayName(UserStore.getUser(b.id)) || b.id))
            : [...list].sort((a, b) => b.addedAt - a.addedAt)
    }, [users, query, sort])

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{
                        width: 36,
                        height: 36,
                        borderRadius: 12,
                        background: C.brandGrad,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        boxShadow: "0 2px 8px rgba(88,101,242,0.3)",
                    }}>
                        <ico.eye />
                    </div>
                    <div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: C.header, lineHeight: 1.2 }}>UserRadar</div>
                        <div style={{ fontSize: 12, color: C.muted }}>watchlist manager</div>
                    </div>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <div className="ur-scrollbar" style={{ padding: "0 16px", maxHeight: "60vh", overflowY: "auto" }}>
                    <AddUserSection onAdded={refresh} />

                    <div style={{ height: 1, background: C.border, margin: "18px 0" }} />

                    {/* watchlist header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                        <div style={{ flex: 1, fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: C.subheader }}>
                            watchlist <span style={{ fontWeight: 500, color: C.muted }}>({users.length})</span>
                        </div>

                        {/* sort toggle */}
                        {(
                            <div role="button" tabIndex={0}
                                onClick={() => setSort(s => s === "az" ? "date" : "az")}
                                title={sort === "az" ? "sort by date" : "sort a-z"}
                                style={{
                                    display: "flex", alignItems: "center", gap: 4,
                                    padding: "0 9px",
                                    borderRadius: 20,
                                    cursor: "pointer",
                                    background: C.bg2,
                                    border: `1px solid ${C.border}`,
                                    color: C.muted,
                                    fontSize: 11,
                                    fontWeight: 600,
                                    userSelect: "none",
                                    height: 28,
                                    boxSizing: "border-box",
                                    overflow: "hidden",
                                }}
                                onMouseEnter={e => (e.currentTarget.style.borderColor = C.bgEl)}
                                onMouseLeave={e => (e.currentTarget.style.borderColor = C.border)}
                            >
                                {sort === "az" ? <ico.sortAz /> : <ico.sortDate />}
                                {sort === "az" ? "a-z" : "newest"}
                            </div>
                        )}

                        {/* search */}
                        {(
                            <SearchInput query={query} setQuery={setQuery} />
                        )}
                    </div>

                    {users.length === 0 && (
                        <div className="ur-fade-in" style={{ textAlign: "center", padding: "48px 0" }}>
                            <div style={{ display: "flex", justifyContent: "center", marginBottom: 14, color: C.muted }}><ico.ghost /></div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: C.header }}>nobody here yet</div>
                            <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>add someone above to start tracking them</div>
                        </div>
                    )}

                    {shown.length === 0 && users.length > 0 && (
                        <div className="ur-fade-in" style={{ textAlign: "center", padding: "32px 0", fontSize: 13, color: C.muted }}>
                            no results for "<b>{query}</b>"
                        </div>
                    )}

                    {shown.map(u => (
                        <WatchedRow key={u.id} user={u} refresh={refresh}
                            onRemove={() => { removeUser(settings, u.id); refresh() }} />
                    ))}
                </div>
            </ModalContent>

            <ModalFooter>
                <button
                    onClick={modalProps.onClose}
                    style={{
                        borderRadius: 20,
                        height: 36,
                        boxSizing: "border-box",
                        padding: "0 18px",
                        background: "transparent",
                        color: C.text,
                        border: `1px solid ${C.border}`,
                        fontSize: 14,
                        fontWeight: 500,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        transition: "background 150ms ease, border-color 150ms ease",
                    }}
                    onMouseEnter={e => {
                        e.currentTarget.style.background = "rgba(255,255,255,0.05)"
                        e.currentTarget.style.borderColor = C.bgEl
                    }}
                    onMouseLeave={e => {
                        e.currentTarget.style.background = "transparent"
                        e.currentTarget.style.borderColor = C.border
                    }}
                >
                    close
                </button>
            </ModalFooter>
        </ModalRoot>
    )
}

// -- plugin --

export default definePlugin({
    name: "UserRadar",
    description: "track users and get notified when they message, edit/delete, type, change profile/avatar, join vc, change status/activity, boost, join/leave servers",
    authors: [{ id: 641266820187160576n, name: "k1ng_op" }],
    settings,

    settingsAboutComponent() {
        return (
            <div>
                <Text variant="heading-sm/semibold" style={{ marginBottom: 8 }}>watchlist</Text>
                <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
                    manage who you're tracking, or right-click any user → watch user
                </Text>
                <button
                    onClick={() => openModal(p => <WatchlistModal modalProps={p} />)}
                    style={{ width: "100%", padding: "8px 14px", background: "var(--brand-500)", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600, fontSize: 14 }}
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
            // ignore optimistic messages (your own sends)
            if (evt.optimistic) return
            if (!featureOn(settings, message.author.id, "msgs", "globalMsgs")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === channelId) return

            const u     = UserStore.getUser(message.author.id)
            const name  = displayName(u ?? message.author)
            const label = getWatchedUser(settings, message.author.id)?.nick
            const dn    = label ? `${label} (${name})` : name
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined

            // type 8 = boost, type 7 = join — handle separately
            if (message.type === 8) {
                if (!featureOn(settings, message.author.id, "boosts", "globalBoosts")) return
                notify({ title: `${dn} boosted a server 🚀`, body: "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                return
            }
            // NOTE: not handling type 7 here anymore — GUILD_MEMBER_ADD is more reliable for joins
            // type 7 fires for every user who can see the channel, not just the one who joined

            if (message.type !== 0 && message.type !== 19) return  // only normal messages and replies

            notify({
                title: `${dn} sent a message`,
                body: msgPreview(message.content, message.attachments?.[0]?.filename),
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

            notify({
                title: `${label ? `${label} (${name})` : name} edited a message`,
                body: msgPreview(message.content, message.attachments?.[0]?.filename),
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

            notify({
                title: `${label ? `${label} (${name})` : name} deleted a message`,
                body, icon,
                onClick: () => jumpTo(evt.guildId, msg!.channel_id, msg!.id),
            })
        },

        TYPING_START(evt: TypingEvent) {
            if (!evt?.userId || !evt?.channelId) return
            // check isWatched FIRST before featureOn — featureOn returns false if not watched
            if (!isWatched(settings, evt.userId)) return
            if (!featureOn(settings, evt.userId, "typing", "globalTyping")) return
            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === evt.channelId) return

            const u = UserStore.getUser(evt.userId)
            if (!u) return

            const label = getWatchedUser(settings, evt.userId)?.nick
            const ch    = ChannelStore.getChannel(evt.channelId)

            notify({
                title: `${label ? `${label} (${displayName(u)})` : displayName(u)} is typing…`,
                body: ch?.name ? `in #${ch.name}` : "click to jump",
                icon: safeAvatar(u.id, (u as any).avatar),
                onClick: () => jumpTo(ch?.guild_id, evt.channelId),
            })
        },

        // fast path for username/avatar changes (comes over websocket instantly)
        USER_UPDATE(evt: { user: any }) {
            if (!evt?.user?.id || !isWatched(settings, evt.user.id)) return
            const old = profileCache[evt.user.id]
            if (!old) return
            checkProfileChanged(evt.user.id, { ...old, user: { ...old.user, ...camelize(evt.user) } })
        },

        // fires when discord fetches a full profile (opening popout, profile page, etc)
        async USER_PROFILE_FETCH_SUCCESS(rawEvt: ProfileFetchEvent) {
            if (!rawEvt?.user?.id) return
            checkProfileChanged(rawEvt.user.id, camelize(rawEvt))
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
                const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined

                if (!prev && channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    notify({ title: `${dn} joined voice`, body: ch ? `#${ch.name}` : "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                } else if (prev && !channelId) {
                    notify({ title: `${dn} left voice`, body: "disconnected", icon, onClick: () => openUserProfile(userId) })
                } else if (prev && channelId && prev !== channelId) {
                    const ch = ChannelStore.getChannel(channelId)
                    notify({ title: `${dn} moved vc`, body: ch ? `now in #${ch.name}` : "click to view", icon, onClick: () => jumpTo(guildId, channelId) })
                }
            }
        },

        PRESENCE_UPDATES(evt: PresenceEvent) {
            for (const update of evt.updates ?? []) {
                const uid = update.user.id
                if (!isWatched(settings, uid)) continue

                const u     = UserStore.getUser(uid)
                const label = getWatchedUser(settings, uid)?.nick
                const dn    = label ? `${label} (${displayName(u)})` : displayName(u)
                const icon  = u ? safeAvatar(u.id, (u as any).avatar) : undefined

                // status change
                if (featureOn(settings, uid, "status", "globalStatus")) {
                    const prev = statusCache[uid]
                    statusCache[uid] = update.status
                    if (prev && prev !== update.status) {
                        notify({
                            title: `${dn} is now ${update.status} ${STATUS_EMOJI[update.status] ?? ""}`,
                            body:  `was: ${prev} ${STATUS_EMOJI[prev] ?? ""}`,
                            icon,
                            onClick: () => openUserProfile(uid),
                        })
                    }
                }

                // activity change — skip type 4 (custom status text), only track real activities
                if (featureOn(settings, uid, "activity", "globalActivity")) {
                    const VERB: Record<number, string> = { 0: "playing", 2: "listening to", 3: "watching", 5: "competing in" }
                    const act    = (update.activities ?? []).find(a => a.type !== 4) ?? null
                    const newKey = act ? `${act.type}:${act.name}` : null
                    const oldKey = activityCache[uid]  // undefined = never seen before

                    activityCache[uid] = newKey

                    // only fire if we've seen this user before (oldKey !== undefined)
                    // otherwise first presence update would always trigger
                    if (oldKey !== undefined && oldKey !== newKey) {
                        if (act) {
                            const verb   = VERB[act.type] ?? "doing"
                            const detail = act.details ? ` — ${act.details}` : ""
                            notify({
                                title: `${dn} is ${verb} ${act.name}`,
                                body:  (`${act.state ?? ""}${detail}`).trim() || `${verb} ${act.name}`,
                                icon,
                                onClick: () => openUserProfile(uid),
                            })
                        } else if (oldKey) {
                            notify({
                                title: `${dn} stopped their activity`,
                                body: "no longer active",
                                icon,
                                onClick: () => openUserProfile(uid),
                            })
                        }
                    }
                }
            }
        },

        GUILD_MEMBER_ADD(evt: GuildMemberEvent) {
            if (!evt?.user?.id || !isWatched(settings, evt.user.id)) return
            if (!featureOn(settings, evt.user.id, "joins", "globalJoins")) return

            // skip if we already knew they were in this guild — happens on discord reconnect
            // where GUILD_MEMBER_ADD fires for everyone already in the server
            if (!guildCache[evt.user.id]) guildCache[evt.user.id] = new Set()
            if (guildCache[evt.user.id].has(evt.guildId)) return
            guildCache[evt.user.id].add(evt.guildId)

            const u     = UserStore.getUser(evt.user.id)
            const label = getWatchedUser(settings, evt.user.id)?.nick
            const dn    = label ? `${label} (${displayName(u ?? evt.user)})` : displayName(u ?? evt.user)
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : safeAvatar(evt.user.id, evt.user.avatar)
            const guild = (findByProps("getGuild")?.getGuild(evt.guildId) as any)

            notify({
                title: `${dn} joined a server`,
                body: guild?.name ?? "click to view",
                icon,
                onClick: () => jumpTo(evt.guildId),
            })
        },

        GUILD_MEMBER_REMOVE(evt: GuildMemberEvent) {
            if (!evt?.user?.id || !isWatched(settings, evt.user.id)) return
            if (!featureOn(settings, evt.user.id, "joins", "globalJoins")) return

            // only fire if we knew they were in this guild
            if (!guildCache[evt.user.id]?.has(evt.guildId)) return
            guildCache[evt.user.id].delete(evt.guildId)

            const u     = UserStore.getUser(evt.user.id)
            const label = getWatchedUser(settings, evt.user.id)?.nick
            const dn    = label ? `${label} (${displayName(u ?? evt.user)})` : displayName(u ?? evt.user)
            const icon  = u ? safeAvatar(u.id, (u as any).avatar) : safeAvatar(evt.user.id, evt.user.avatar)
            const guild = (findByProps("getGuild")?.getGuild(evt.guildId) as any)

            notify({
                title: `${dn} left a server`,
                body: guild?.name ?? "click to view",
                icon,
                onClick: () => openUserProfile(evt.user.id),
            })
        },
    },

    async start() {
        addContextMenuPatch("user-context", ctxPatch)

        if (typeof Notification !== "undefined" && Notification.permission === "default") {
            Notification.requestPermission()
        }

        // pre-fetch profiles as baseline (so first poll doesn't spam false positives)
        // also snapshot current vc/status/activity state for everyone on the watchlist
        // without this, if a user is already in vc when the plugin loads, the first
        // VOICE_STATE_UPDATES event looks like a "join" even though they were already there
        for (const wu of getWatchlist(settings)) {
            try {
                const { body } = await RestAPI.get({
                    url: `/users/${wu.id}/profile`,
                    query: { with_mutual_guilds: false, with_mutual_friends_count: false },
                })
                profileCache[wu.id] = camelize(body)
            } catch { }

            // snapshot current voice state so we don't false-positive on plugin load
            try {
                const vStates = findByProps("getVoiceStateForUser")
                const vs = vStates?.getVoiceStateForUser(wu.id)
                vcCache[wu.id] = vs?.channelId ?? null
            } catch { vcCache[wu.id] = null }

            // snapshot current status/activity so first PRESENCE_UPDATES doesn't fire
            try {
                const presence = findByProps("getStatus", "getActivities")
                if (presence) {
                    const status = presence.getStatus(wu.id)
                    if (status) statusCache[wu.id] = status

                    const activities: any[] = presence.getActivities(wu.id) ?? []
                    const act = activities.find((a: any) => a.type !== 4) ?? null
                    activityCache[wu.id] = act ? `${act.type}:${act.name}` : null
                }
            } catch { }

            // snapshot which guilds they're already in so GUILD_MEMBER_ADD doesn't
            // false-positive on discord reconnect re-sync
            try {
                const GuildStore = findByProps("getGuildIds", "getGuild")
                if (GuildStore) {
                    const guildIds: string[] = GuildStore.getGuildIds() ?? []
                    const MemberStore = findByProps("getMember", "isMember")
                    if (MemberStore) {
                        guildCache[wu.id] = new Set(
                            guildIds.filter(gid => MemberStore.isMember(gid, wu.id))
                        )
                    }
                }
            } catch { }
        }

        pollTimer = setInterval(pollProfiles, 5 * 60 * 1000)

        tryLoadLoggedMsgs().then(m => {
            if (m) log.info("connected to message logger")
            else   log.warn("message logger not found — delete content unavailable")
        })
    },

    stop() {
        removeContextMenuPatch("user-context", ctxPatch)
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        for (const k in profileCache)  delete profileCache[k]
        for (const k in vcCache)       delete vcCache[k]
        for (const k in statusCache)   delete statusCache[k]
        for (const k in activityCache) delete activityCache[k]
        for (const k in guildCache)    delete guildCache[k]
        loggedMsgs = null
    },

    async watchUser(uid: string) {
        addUser(settings, uid)
        const u = UserStore.getUser(uid)
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `now watching ${displayName(u)}`, id: Toasts.genId() })
        try {
            const { body } = await RestAPI.get({
                url: `/users/${uid}/profile`,
                query: { with_mutual_guilds: false, with_mutual_friends_count: false },
            })
            profileCache[uid] = camelize(body)
        } catch { }
    },

    unwatchUser(uid: string) {
        const u = UserStore.getUser(uid)
        removeUser(settings, uid)
        delete profileCache[uid]
        delete vcCache[uid]
        delete statusCache[uid]
        delete activityCache[uid]
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `stopped watching ${displayName(u)}`, id: Toasts.genId() })
    },
})

// right-click context menu
const ctxPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.user) return
    if (props.user.id === UserStore.getCurrentUser()?.id) return
    if (children.some((c: any) => c?.props?.id === "ur-ctx")) return

    const uid      = props.user.id
    const watching = isWatched(settings, uid)

    const eyeIcon = watching
        ? <CtxEyeOffIcon />
        : <CtxEyeIcon />
    const gearIcon = <CtxGearIcon />

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuGroup id="ur-ctx">
            <Menu.MenuItem
                id="ur-toggle"
                label={(
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                        <span>{watching ? "Stop watching" : "Watch user"}</span>
                        <span style={{ marginLeft: 12, opacity: 0.6, display: "flex", alignItems: "center" }}>{eyeIcon}</span>
                    </div>
                )}
                action={() => {
                    const plugin = Vencord.Plugins.plugins["UserRadar"] as any
                    watching ? plugin.unwatchUser(uid) : plugin.watchUser(uid)
                }}
            />
            {watching && (
                <Menu.MenuItem
                    id="ur-open"
                    label={(
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                            <span>Manage watchlist</span>
                            <span style={{ marginLeft: 12, opacity: 0.6, display: "flex", alignItems: "center" }}>{gearIcon}</span>
                        </div>
                    )}
                    action={() => openModal(p => <WatchlistModal modalProps={p} />)}
                />
            )}
        </Menu.MenuGroup>
    )
}
