// index.tsx — UserRadar
// k1ng_op
//
// stalker plugin, basically
// watch specific discord users and get pinged whenever they do anything
// msgs, edits, deletes, typing, profile/pfp changes, voice, status, activity, boosts, joins

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu"
import { DataStore, Notifications } from "@api/index"
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
    isWatched, log, patchUser, removeUser
} from "./store"

import {
    GuildMemberEvent, MsgCreateEvent, MsgDeleteEvent, MsgUpdateEvent,
    PresenceEvent, ProfileFetchEvent,
    TypingEvent, VoiceStateEvent, WatchedUser
} from "./types"

const STATUS_EMOJI_LOCAL: Record<string, string> = {
    online: "🟢",
    idle: "🌙",
    dnd: "🔴",
    offline: "⚫",
    invisible: "⚫",
}
const ACTIVITY_LOG_KEY = "UserRadar_ActivityLog_v2"
export type ActivityType =
    | "msg" | "edit" | "delete" | "typing"
    | "status" | "activity" | "voice"
    | "join" | "leave" | "boost"
    | "profile" | "avatar" | "banner" | "bio" | "username" | "displayname"
    | "online" | "offline" | "idle" | "dnd"
    | "game_start" | "game_stop" | "spotify" | "streaming"
    | "vc_join" | "vc_leave" | "vc_move"
    | "session"

export interface ActivityEntry {
    id: string
    uid: string
    ts: number
    type: ActivityType
    icon: string
    title: string
    body: string
    guildId?: string
    channelId?: string
    msgId?: string
    metadata?: Record<string, any>
}

function sessionKey(uid: string, type: string, channelId?: string): string {
    return channelId ? `${uid}_${type}_${channelId}` : `${uid}_${type}`
}

class ActivityStore {
    private cache: Record<string, ActivityEntry[]> = {}
    private loaded = false

    async load() {
        if (this.loaded) return
        try {
            const data = await DataStore.get(ACTIVITY_LOG_KEY)
            if (data) this.cache = JSON.parse(data)
        } catch (e) { console.error("[UserRadar] Failed to load activity log", e) }
        this.loaded = true
    }

    async save() {
        try {
            await DataStore.set(ACTIVITY_LOG_KEY, JSON.stringify(this.cache))
        } catch (e) { console.error("[UserRadar] Failed to save activity log", e) }
    }

    getLogs(uid: string): ActivityEntry[] {
        return this.cache[uid] || []
    }

    async addLog(entry: Omit<ActivityEntry, "id">) {
        await this.load()
        if (!this.cache[entry.uid]) this.cache[entry.uid] = []
        const fullEntry: ActivityEntry = {
            ...entry,
            id: `${entry.uid}_${entry.ts}_${Math.random().toString(36).slice(2, 8)}`,
        }
        this.cache[entry.uid].unshift(fullEntry)
        await this.save()
        return fullEntry
    }

    async clearLogs(uid: string) {
        await this.load()
        delete this.cache[uid]
        await this.save()
    }

    async clearAll() {
        this.cache = {}
        await DataStore.del(ACTIVITY_LOG_KEY)
    }

    exportAll(): string {
        return JSON.stringify(this.cache, null, 2)
    }

    async importAll(json: string) {
        try {
            this.cache = JSON.parse(json)
            await this.save()
            return true
        } catch { return false }
    }

    async updateLog(uid: string, logId: string, updates: Partial<ActivityEntry>) {
        await this.load()
        const logs = this.cache[uid]
        if (!logs) return false
        const idx = logs.findIndex(l => l.id === logId)
        if (idx === -1) return false
                const updated = { ...logs[idx], ...updates, ts: Date.now() }
        logs.splice(idx, 1)
        logs.unshift(updated)
        await this.save()
                emitActivityUpdate(uid, updated)
        return true
    }

    async removeLog(uid: string, logId: string) {
        await this.load()
        const logs = this.cache[uid]
        if (!logs) return false
        this.cache[uid] = logs.filter(l => l.id !== logId)
        await this.save()
        return true
    }
}

export const activityStore = new ActivityStore()

const activityListeners = new Set<(uid: string, entry: ActivityEntry) => void>()

export function onActivityUpdate(cb: (uid: string, entry: ActivityEntry) => void) {
    activityListeners.add(cb)
    return () => activityListeners.delete(cb)
}

function emitActivityUpdate(uid: string, entry: ActivityEntry) {
    activityListeners.forEach(cb => cb(uid, entry))
}

export async function logUserActivity(
    uid: string,
    type: ActivityType,
    icon: string,
    title: string,
    body: string,
    options?: {
        guildId?: string
        channelId?: string
        msgId?: string
        metadata?: Record<string, any>
    }
) {
    const entry = await activityStore.addLog({
        uid, ts: Date.now(), type, icon, title, body, ...options,
    })
    emitActivityUpdate(uid, entry)
    return entry
}

function logActivity(uid: string, type: string, icon: string, body: string, guildId?: string, channelId?: string, msgId?: string) {
    logUserActivity(uid, type as ActivityType, icon, body, body, { guildId, channelId, msgId }).catch(() => {})
}

const profileCache:  Record<string, any>                          = {}
const vcCache:       Record<string, string | null>                = {}
const statusCache:   Record<string, string>                       = {}
const activityCache: Record<string, string | null | undefined>    = {}
const guildCache:    Record<string, Set<string>>                  = {}
const vcJoinTime:    Record<string, number>                       = {}
const clientCache:   Record<string, string | null>                = {}
const cameraCache:   Record<string, boolean>                      = {}
const streamCache:   Record<string, boolean>                      = {}
const statusSessionCache: Record<string, { startTime: number; startStatus: string; changes: { status: string; ts: number }[]; platforms: { platform: string; ts: number }[] } | null> = {}  // status session tracking

const activeSessions: Record<string, { logId: string; startTime: number; channelId?: string; guildId?: string; metadata?: any }> = {}

let pluginStartedAt = 0

let loggedMsgs: Record<string, Message> | null = null
let pollTimer:  ReturnType<typeof setInterval> | null = null

function tryLoadLoggedMsgs() {
    if (loggedMsgs) return loggedMsgs

    try {
        const plugin = (Vencord as any)?.Plugins?.plugins?.["vc-message-logger-enhanced"]
            ?? (Vencord as any)?.Plugins?.plugins?.["MessageLoggerEnhanced"]
            ?? (Vencord as any)?.Plugins?.plugins?.["messageLoggerEnhanced"]
        if (plugin?.loggedMessages)       { loggedMsgs = plugin.loggedMessages;       return loggedMsgs }
        if (plugin?.store?.loggedMessages) { loggedMsgs = plugin.store.loggedMessages; return loggedMsgs }
    } catch { }

    try {
        const { wreq } = (window as any).webpackChunkdiscord_app?.find?.(
            (x: any) => x?.[1]?.["loggedMessages"]
        )?.[1] ?? {}
        if (wreq?.["loggedMessages"]) { loggedMsgs = wreq["loggedMessages"]; return loggedMsgs }
    } catch { }

    return null
}

const settings = definePluginSettings({
    watchlist:          { type: OptionType.STRING,  hidden: true,  default: "[]",    description: "watchlist json — managed by the ui, don't touch" },
    globalPresetMode:   { type: OptionType.STRING,  hidden: true,  default: "custom",               description: "global preset mode" },
    installedSha:       { type: OptionType.STRING,  hidden: true,  default: "none",  description: "installed commit sha" },
    globalMsgs:         { type: OptionType.BOOLEAN, default: true,                   description: "messages" },
    globalEdits:        { type: OptionType.BOOLEAN, default: true,                   description: "edits" },
    globalDeletes:      { type: OptionType.BOOLEAN, default: true,                   description: "deletes (needs msg-logger-enhanced)" },
    globalTyping:       { type: OptionType.BOOLEAN, default: true,                   description: "typing" },
    globalProfile:      { type: OptionType.BOOLEAN, default: true,                   description: "profile changes" },
    globalAvatar:       { type: OptionType.BOOLEAN, default: true,                   description: "avatar changes" },
    globalVoice:        { type: OptionType.BOOLEAN, default: true,                   description: "voice" },
    globalStatus:       { type: OptionType.BOOLEAN, default: false,                  description: "status (spammy)" },
    globalJoins:        { type: OptionType.BOOLEAN, default: true,                   description: "server joins/leaves" },
    showPreview:        { type: OptionType.BOOLEAN, default: true,                   description: "show message preview" },
    previewLen:         { type: OptionType.NUMBER,  default: 0,                    description: "preview length (0 = unlimited)" },
    quietHours:         { type: OptionType.BOOLEAN, default: false,                  description: "quiet hours" },
    quietStart:         { type: OptionType.STRING,  default: "23:00",                description: "quiet hours start (24h, e.g. 23:00)" },
    quietEnd:           { type: OptionType.STRING,  default: "07:00",                description: "quiet hours end (24h, e.g. 07:00)" },
    skipCurrentChannel: { type: OptionType.BOOLEAN, default: true,                   description: "skip if already in that channel" },
    debugLog:           { type: OptionType.BOOLEAN, default: false,                  description: "debug logging" },
    showToolbarIcon:    { type: OptionType.BOOLEAN, default: true,                   description: "toolbar icon" },
})

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

function isFeatureOn(uid: string, userKey: keyof WatchedUser["overrides"], globalKey: string): boolean {
    if (!isWatched(settings, uid)) return false
    const mode = settings.store.globalPresetMode ?? "custom"
    if (mode !== "custom") {
        if (mode === "silent") return false
        if (mode === "stalker") return true
        if (mode === "lite") {
            const liteFeatures = ["msgs", "edits", "deletes", "typing", "avatar", "voice"]
            return liteFeatures.includes(userKey as string)
        }
    }
    return featureOn(settings, uid, userKey, globalKey)
}

const _notifDebounce: Record<string, number> = {}

function notify(opts: { title: string; body: string; icon?: string; onClick?: () => void }) {
    if (inQuietHours(settings)) return
    if (settings.store.globalPresetMode === "silent") return

    const key = `${opts.title}|${opts.body}`
    const now = Date.now()
    if (_notifDebounce[key] && now - _notifDebounce[key] < 1500) return
    _notifDebounce[key] = now

    if (settings.store.debugLog) log.info(`[notif] ${opts.title} — ${opts.body}`)
    Notifications.showNotification({ title: opts.title, body: opts.body, icon: opts.icon, onClick: opts.onClick })
}

function avatarUrl(id: string, hash?: string | null, size = 80): string {
    try {
        if (hash) return `https://cdn.discordapp.com/avatars/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=${size}`
        let i = 0
        try { i = Number(BigInt(id) % BigInt(6)) } catch { i = parseInt(id.slice(-4), 10) % 6 || 0 }
        return `https://cdn.discordapp.com/embed/avatars/${i}.png`
    } catch { return "https://cdn.discordapp.com/embed/avatars/0.png" }
}

function bannerUrl(id: string, hash?: string | null): string | null {
    if (!hash) return null
    return `https://cdn.discordapp.com/banners/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=480`
}

function hexColor(n?: number | null): string | null {
    if (n == null) return null
    try { return "#" + n.toString(16).padStart(6, "0") } catch { return null }
}

const FALLBACK_AV = "https://cdn.discordapp.com/embed/avatars/0.png"

const PROFILE_TEXT = ["username", "globalName", "bio", "banner"] as const
const FIELD_NAME: Record<string, string> = {
    username: "username", globalName: "display name",
    bio: "bio", banner: "banner",
}

function checkProfileChanged(uid: string, fresh: any) {
    if (!isWatched(settings, uid)) return
    const old = profileCache[uid]
    if (!old) {
        profileCache[uid] = fresh
        return
    }
    if (fresh.user?.avatar !== old.user?.avatar) {
        if (isFeatureOn( uid, "avatar", "globalAvatar")) {
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
        profileCache[uid] = { ...profileCache[uid], user: { ...profileCache[uid].user, avatar: fresh.user?.avatar } }
    }
    const changed: string[] = []
    for (const f of PROFILE_TEXT) {
        if ((fresh.user?.[f] ?? null) !== (old.user?.[f] ?? null)) changed.push(f)
    }
    if (changed.length > 0 && isFeatureOn( uid, "profile", "globalProfile")) {
        const u     = UserStore.getUser(uid)
        const name  = displayName(fresh.user)
        const label = getWatchedUser(settings, uid)?.nick
        const dn    = label ? `${label} (${name})` : name
        notify({
            title: `${dn} updated their profile`,
            body: changed.map(f => FIELD_NAME[f] ?? f).join(", "),
            icon: u ? avatarUrl(u.id, (u as any).avatar) : undefined,
            onClick: () => openUserProfile(uid),
        })
    }
    profileCache[uid] = fresh
}

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

const STYLE_ID = "ur-s9"
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement("style")
    s.id = STYLE_ID
    s.textContent = `
        @keyframes ur-spin { to { transform:rotate(360deg) } }
        .ur-spin { display:inline-block;width:14px;height:14px;border-radius:50%;
            border:2.5px solid #3f4147;border-top-color:#dbdee1;
            animation:ur-spin .55s linear infinite;vertical-align:middle; }
        @keyframes ur-fade-in { from { opacity:0;transform:translateY(-4px) } to { opacity:1;transform:translateY(0) } }
        .ur-fade-in { animation:ur-fade-in .2s cubic-bezier(.4,0,.2,1) forwards; }
        .ur-expand { display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s cubic-bezier(.4,0,.2,1); }
        .ur-expand.open { grid-template-rows:1fr; }
        .ur-expand > div { overflow:hidden; }
        .ur-row-hover:hover { background:rgba(255,255,255,0.06); }

        /* Discord-style thin scrollbar - only visible on hover */
        .ur-scrollbar::-webkit-scrollbar { width:4px; height:4px; }
        .ur-scrollbar::-webkit-scrollbar-track { background:transparent; }
        .ur-scrollbar::-webkit-scrollbar-thumb { background:transparent; border-radius:4px; }
        .ur-scrollbar:hover::-webkit-scrollbar-thumb { background:#3f4147; }
        .ur-scrollbar::-webkit-scrollbar-thumb:hover { background:#4a4a6e; }

        /* Firefox scrollbar */
        .ur-scrollbar { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .ur-scrollbar:hover { scrollbar-color: #3f4147 transparent; }

        .ur-typing-dot { animation: ur-typing 1.4s infinite ease-in-out both; }
        .ur-typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .ur-typing-dot:nth-child(2) { animation-delay: -0.16s; }
        @keyframes ur-typing { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
        @keyframes ur-shake { 0%, 100% { transform: translateX(0); } 10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); } 20%, 40%, 60%, 80% { transform: translateX(4px); } }
        .ur-shake { animation: ur-shake 0.5s cubic-bezier(.36,.07,.19,.97) both; }
        @keyframes ur-pulse { 0% { box-shadow: 0 0 0 0 #5865f2; } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
        .ur-pulse { animation: ur-pulse 2s infinite; }
        @keyframes ur-flash-green { 0% { background: #248046; } 100% { background: #5865f2; } }
        .ur-flash-green { animation: ur-flash-green 0.5s ease; }

        /* Activity log modal specific - prevent horizontal scroll */
        .ur-activity-modal { overflow-x: hidden !important; }
        .ur-activity-modal * { max-width: 100%; box-sizing: border-box; }
    `
    document.head.appendChild(s)
}

const CLIENT_EMOJI: Record<string, string> = {
    desktop:  "💻",
    mobile:   "📱",
    web:      "🌐",
    embedded: "🎮",
    vr:       "🥽",
}

function resolveClient(cs?: Record<string, string> | null): string | null {
    if (!cs) return null
    if (cs.mobile)   return "mobile"
    if (cs.desktop)  return "desktop"
    if (cs.web)      return "web"
    if (cs.embedded) return "embedded"
    if (cs.vr)       return "vr"
    const first = Object.keys(cs).find(k => cs[k])
    return first ?? null
}

const CLIENT_LABEL_MAP: Record<string, string> = { desktop: "Desktop", mobile: "Mobile", web: "Web", embedded: "Console", vr: "VR" }
function platformSuffixLog(uid: string): string {
    const c = clientCache[uid]
    if (!c) return ""
    return ` · on ${CLIENT_EMOJI[c] || "📡"} ${CLIENT_LABEL_MAP[c] || c}`
}

const C = {
    bg1:         "#1e1f22",
    bg2:         "#2b2d31",
    bg3:         "#313338",
    bgEl:        "#3f4147",
    border:      "#3f4147",
    hov:         "rgba(255,255,255,0.06)",
    header:      "#f2f3f5",
    subheader:   "#b5bac1",
    text:        "#dbdee1",
    muted:       "#949ba4",
    danger:      "#fa777c",
    brand:       "#5865f2",
    brandLight:  "#949cf4",
    brandGrad:   "linear-gradient(135deg, #5865f2 0%, #949cf4 100%)",
    green:       "#248046",
    red:         "#da373c",
    white:       "#ffffff",
    expanded:    "#232428",
} as const

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
    eye:      () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.white} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3" fill={C.white} stroke="none"/><path d="M12 2v2M12 20v2" strokeWidth="1.5" opacity="0.5"/></svg>,
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
    history:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
    monitor:  () => <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
    preview:  () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    catAll:       () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>,
    catMsg:       () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    catEdit:      () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4L18.5 2.5z"/></svg>,
    catDelete:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
    catTyping:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="20" y2="18"/></svg>,
    catStatus:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
    catVoice:     () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>,
    catAvatar:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>,
    catProfile:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    catActivity:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,

    location: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
    clock:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
    filter:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
    stats:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    download: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    upload:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
    clear:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
    calendar: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,

}

const CtxEyeIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18 }}>
        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        <path fillRule="evenodd" d="M1.323 11.447C2.811 6.976 7.028 3.75 12.001 3.75c4.97 0 9.185 3.223 10.675 7.69.12.362.12.752 0 1.113-1.487 4.471-5.705 7.697-10.677 7.697-4.97 0-9.186-3.223-10.675-7.69a1.762 1.762 0 0 1 0-1.113ZM17.25 12a5.25 5.25 0 1 1-10.5 0 5.25 5.25 0 0 1 10.5 0Z" clipRule="evenodd" />
    </svg>
)
const CtxEyeOffIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18 }}>
        <path d="M3.53 2.47a.75.75 0 0 0-1.06 1.06l18 18a.75.75 0 1 0 1.06-1.06l-18-18ZM22.676 12.553a11.249 11.249 0 0 1-2.631 4.31l-3.099-3.099a5.25 5.25 0 0 0-6.71-6.71L7.759 4.577a11.217 11.217 0 0 1 4.242-.827c4.97 0 9.185 3.223 10.675 7.69.12.362.12.752 0 1.113Z" />
        <path d="M15.75 12c0 .18-.013.357-.037.53l-4.244-4.243A3.75 3.75 0 0 1 15.75 12ZM12.53 15.713l-4.243-4.244a3.75 3.75 0 0 0 4.244 4.243Z" />
        <path d="M6.75 12c0-.619.107-1.213.304-1.764l-3.1-3.1a11.25 11.25 0 0 0-2.63 4.31c-.12.362-.12.752 0 1.114 1.489 4.467 5.704 7.69 10.675 7.69 1.5 0 2.933-.294 4.242-.827l-2.477-2.477A5.25 5.25 0 0 1 6.75 12Z" />
    </svg>
)
const CtxGearIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18 }}>
        <path fillRule="evenodd" d="M2.25 5.25a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3V15a3 3 0 0 1-3 3h-3v.257c0 .597.237 1.17.659 1.591l.621.622a.75.75 0 0 1-.53 1.28h-9a.75.75 0 0 1-.53-1.28l.621-.622a2.25 2.25 0 0 0 .659-1.59V18h-3a3 3 0 0 1-3-3V5.25Zm1.5 0v7.5a1.5 1.5 0 0 0 1.5 1.5h13.5a1.5 1.5 0 0 0 1.5-1.5v-7.5a1.5 1.5 0 0 0-1.5-1.5H5.25a1.5 1.5 0 0 0-1.5 1.5Z" clipRule="evenodd" />
    </svg>
)

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
    return (
        <div
            role="switch" aria-checked={on}
            onClick={() => onChange(!on)}
            style={{
                width: 36, height: 22, borderRadius: 11, flexShrink: 0,
                background: on ? "#5865f2" : "#3f4147",
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

type LookupStage =
    | { s: "idle" }
    | { s: "loading" }
    | { s: "done"; user: any; av: string }
    | { s: "err"; msg: string }

function timeAgo(ts: number): string {
    const diff = Date.now() - ts
    const d    = new Date(ts)
    const now  = new Date()
    const mins = Math.floor(diff / 60000)
    const isSameDay = d.getDate() === now.getDate() &&
                      d.getMonth() === now.getMonth() &&
                      d.getFullYear() === now.getFullYear()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const isYesterday = d.getDate() === yesterday.getDate() &&
                        d.getMonth() === yesterday.getMonth() &&
                        d.getFullYear() === yesterday.getFullYear()

    if (mins < 1)    return "just now"
    if (mins < 60)   return `${mins}m ago`
    if (isSameDay)   return "Today"
    if (isYesterday) return "Yesterday"
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function exactTime(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium", hour12: true })
}

function logTime(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium", hour12: true })
}
function decodeSnowflake(id: string) {
    try {
        const snowflake = BigInt(id)
        const timestamp = Number(snowflake >> 22n) + 1420070400000
        const workerId = Number((snowflake >> 17n) & 0x1Fn)
        const processId = Number((snowflake >> 12n) & 0x1Fn)
        const increment = Number(snowflake & 0xFFFn)
        return { timestamp, workerId, processId, increment, date: new Date(timestamp) }
    } catch {
        return null
    }
}

function AddUserInput({ rawId, setRawId, hasErr, lk, setLk, doLookup }: {
    rawId: string
    setRawId: (v: string) => void
    hasErr: boolean
    lk: LookupStage
    setLk: (v: LookupStage) => void
    doLookup: () => void
}) {
    const [focused, setFocused] = React.useState(false)
    const [btnState, setBtnState] = React.useState<"idle" | "valid" | "searching" | "found" | "notfound">("idle")
    const btnRef = React.useRef<HTMLButtonElement>(null)
    const borderColor = hasErr ? C.red : focused ? C.brand : C.border

    React.useEffect(() => {
        const clean = rawId.trim().replace(/\D/g, "")
        if (lk.s === "loading") setBtnState("searching")
        else if (lk.s === "done") {
            setBtnState("found")
            const t = setTimeout(() => setBtnState("idle"), 2000)
            return () => clearTimeout(t)
        }
        else if (lk.s === "err") {
            setBtnState("notfound")
            const t = setTimeout(() => setBtnState("idle"), 3000)
            return () => clearTimeout(t)
        }
        else if (clean.length >= 17 && clean.length <= 20) setBtnState("valid")
        else setBtnState("idle")
    }, [rawId, lk.s])

    const btnStyle: React.CSSProperties = {
        borderRadius: 20,
        height: 40,
        boxSizing: "border-box",
        padding: "0 20px",
        color: "#ffffff",
        border: "none",
        fontSize: 14,
        fontWeight: 600,
        cursor: btnState === "idle" ? "not-allowed" : "pointer",
        flexShrink: 0,
        fontFamily: "inherit",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 200ms ease, opacity 200ms ease",
    }

    const getBtnBg = () => {
        if (btnState === "found") return "#248046"
        if (btnState === "notfound") return "#da373c"
        if (btnState === "searching") return "#4752c4"
        if (btnState === "valid") return "#5865f2"
        return "rgba(255,255,255,0.06)"
    }

    const getBtnText = () => {
        if (btnState === "found") return "Added ✓"
        if (btnState === "notfound") return "Not found"
        if (btnState === "searching") return <><span className="ur-spin" style={{ marginRight: 6 }} />Searching...</>
        return "look up"
    }

    return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <input
                    placeholder="paste a discord user id"
                    value={rawId}
                    onChange={(e) => { setRawId(e.target.value); if (hasErr) setLk({ s: "idle" }) }}
                    onKeyDown={(e) => { if (e.key === "Enter" && btnState !== "idle") doLookup() }}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    autoFocus
                    style={{
                        background: "#1e1f22",
                        borderRadius: 20,
                        border: `1px solid ${borderColor}`,
                        height: 40,
                        boxSizing: "border-box",
                        padding: "0 14px",
                        transition: "border-color 150ms ease, box-shadow 150ms ease",
                        width: "100%",
                        fontSize: 14,
                        color: "#dbdee1",
                        outline: "none",
                        fontFamily: "inherit",
                        boxShadow: focused ? "inset 0 0 0 1px #5865f2" : "none",
                    }}
                />
                <div style={{ fontSize: 11, color: hasErr ? C.danger : C.muted, marginTop: 5, display: "flex", alignItems: "center", gap: 4 }}>
                    {hasErr ? <ico.x /> : null}
                    {hasErr ? (lk as any).msg : "developer mode → right-click user → copy user id"}
                </div>
            </div>
            <button
                ref={btnRef}
                onClick={() => { if (btnState !== "idle") doLookup() }}
                className={btnState === "notfound" ? "ur-shake" : btnState === "valid" ? "ur-pulse" : ""}
                style={{ ...btnStyle, background: getBtnBg(), opacity: btnState === "idle" ? 0.5 : 1 }}
            >
                {getBtnText()}
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
                background: "#1e1f22",
                borderRadius: 20,
                border: `1px solid ${focused ? C.brand : "#3f4147"}`,
                height: 40,
                boxSizing: "border-box",
                padding: "0 14px",
                transition: "border-color 150ms ease",
                width: "100%",
                fontSize: 14,
                color: "#dbdee1",
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
    const [copiedId, setCopiedId] = React.useState(false)

    const cleanId = rawId.trim().replace(/\D/g, "")
    const hasErr  = lk.s === "err"

    const copyId = (id: string) => {
        navigator.clipboard.writeText(id)
        setCopiedId(true)
        setTimeout(() => setCopiedId(false), 1200)
    }

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
                    <div style={{
                        background: C.bg1,
                        borderRadius: 16,
                        border: `1px solid ${C.border}`,
                        marginBottom: 14,
                        overflow: "hidden",
                    }}>
                        <div style={{ padding: "12px 16px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                                <img
                                    src={lk.av}
                                    style={{
                                        width: 52, height: 52,
                                        borderRadius: "50%",
                                        border: `2px solid ${C.border}`,
                                        flexShrink: 0,
                                        background: C.bg1,
                                    }}
                                    onError={(e: any) => { e.target.src = FALLBACK_AV }}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 17, fontWeight: 800, color: C.header, lineHeight: 1.2 }}>
                                            {lk.user.globalName || lk.user.username}
                                        </span>
                                        {lk.user.globalName && (
                                            <span style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}>@{lk.user.username}</span>
                                        )}
                                    </div>
                                    {lk.user.pronouns && (
                                        <div style={{ fontSize: 11, color: C.brandLight, marginTop: 2, fontWeight: 500 }}>
                                            {lk.user.pronouns}
                                        </div>
                                    )}
                                </div>
                                <div style={{
                                    width: 20, height: 20,
                                    borderRadius: "50%",
                                    background: "rgba(36,128,70,0.15)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                }}>
                                    <span style={{ color: C.green, display: "flex", transform: "scale(0.8)" }}><ico.check /></span>
                                </div>
                            </div>

                            {lk.user.bio && (
                                <div style={{ marginBottom: 10 }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: C.subheader, marginBottom: 4 }}>
                                        About Me
                                    </div>
                                    <div style={{
                                        fontSize: 12,
                                        color: C.text,
                                        lineHeight: 1.5,
                                        padding: "8px 10px",
                                        background: C.bg2,
                                        borderRadius: 8,
                                        border: `1px solid ${C.border}`,
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word",
                                    }}>
                                        {lk.user.bio}
                                    </div>
                                </div>
                            )}

                            <div style={{ height: 1, background: C.border, margin: "8px 0" }} />

                            {(() => {
                                const sf = decodeSnowflake(lk.user.id)
                                return sf && (
                                <div>
                                    <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: C.subheader, marginBottom: 5 }}>
                                        Account Info
                                    </div>
                                    <div style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(2, 1fr)",
                                        gap: 6,
                                    }}>
                                        <div
                                            onClick={() => copyId(lk.user.id)}
                                            style={{
                                                padding: "8px 10px",
                                                background: C.bg2,
                                                borderRadius: 8,
                                                border: `1px solid ${C.border}`,
                                                cursor: "pointer",
                                                transition: "border-color 150ms ease, background 150ms ease",
                                            }}
                                            onMouseEnter={e => { e.currentTarget.style.borderColor = C.bgEl; e.currentTarget.style.background = "#232428" }}
                                            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.bg2 }}
                                            title="Click to copy ID"
                                        >
                                            <div style={{ fontSize: 10, color: C.muted, marginBottom: 2, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>User ID</div>
                                            <div style={{ fontSize: 11, fontFamily: "monospace", color: C.text, display: "flex", alignItems: "center", gap: 4 }}>
                                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lk.user.id}</span>
                                                <span style={{ color: copiedId ? C.green : C.muted, flexShrink: 0, transition: "color 150ms ease", display: "flex" }}>
                                                    {copiedId ? <ico.check /> : <ico.copy />}
                                                </span>
                                            </div>
                                        </div>

                                        <div style={{ padding: "8px 10px", background: C.bg2, borderRadius: 8, border: `1px solid ${C.border}` }}>
                                            <div style={{ fontSize: 10, color: C.muted, marginBottom: 2, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>Created</div>
                                            <div style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>
                                                {sf.date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                                            </div>
                                            <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>
                                                {sf.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                                            </div>
                                        </div>

                                        <div style={{ padding: "8px 10px", background: C.bg2, borderRadius: 8, border: `1px solid ${C.border}` }}>
                                            <div style={{ fontSize: 10, color: C.muted, marginBottom: 2, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>Account Age</div>
                                            <div style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>
                                                {(() => {
                                                    const diff = Date.now() - sf.timestamp
                                                    const years = Math.floor(diff / 31536000000)
                                                    const months = Math.floor((diff % 31536000000) / 2592000000)
                                                    const days = Math.floor((diff % 2592000000) / 86400000)
                                                    if (years > 0) return `${years}y ${months}mo`
                                                    if (months > 0) return `${months}mo ${days}d`
                                                    return `${days}d`
                                                })()}
                                            </div>
                                        </div>

                                        <div
                                            title={`Worker ${sf.workerId} · Process ${sf.processId} · Increment ${sf.increment}`}
                                            style={{ padding: "8px 10px", background: C.bg2, borderRadius: 8, border: `1px solid ${C.border}` }}
                                        >
                                            <div style={{ fontSize: 10, color: C.muted, marginBottom: 2, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>Snowflake</div>
                                            <div style={{ fontSize: 11, fontFamily: "monospace", color: C.brandLight, fontWeight: 600 }}>
                                                w{sf.workerId} · p{sf.processId}
                                            </div>
                                            <div style={{ fontSize: 10, color: C.muted, marginTop: 1, fontFamily: "monospace" }}>
                                                inc {sf.increment}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                )
                            })()}
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
                                color: "#ffffff",
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

const OV_GROUPS = {
    messages: [
        { label: "messages",  key: "msgs",     gk: "globalMsgs",     Icon: ico.msg,      desc: "Notify on new messages" },
        { label: "edits",     key: "edits",    gk: "globalEdits",    Icon: ico.edit,     desc: "Notify on message edits" },
        { label: "deletes",   key: "deletes",  gk: "globalDeletes",  Icon: ico.del,      desc: "Notify on deleted messages" },
        { label: "typing",    key: "typing",   gk: "globalTyping",   Icon: ico.typing,   desc: "Notify when typing starts" },
    ],
    presence: [
        { label: "status",    key: "status",   gk: "globalStatus",   Icon: ico.status,   desc: "Notify on status changes" },
        { label: "activity",  key: "activity", gk: "globalActivity", Icon: ico.activity, desc: "Game/music activity (off by default)" },
        { label: "voice",     key: "voice",    gk: "globalVoice",    Icon: ico.voice,    desc: "Notify on voice channel activity" },
        { label: "joins",     key: "joins",    gk: "globalJoins",    Icon: ico.joins,    desc: "Notify on server joins / leaves" },
    ],
    profile: [
        { label: "profile",   key: "profile",  gk: "globalProfile",  Icon: ico.profile,  desc: "Notify on profile changes" },
        { label: "avatar",    key: "avatar",   gk: "globalAvatar",   Icon: ico.avatar,   desc: "Notify on avatar updates" },
    ],
} as const

type OvTab = "messages" | "presence" | "profile"
const OV_TAB_LABELS: Record<OvTab, string> = { messages: "Messages", presence: "Presence", profile: "Profile" }

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
    return (
        <div style={{ position: "relative", width: 160, flexShrink: 0 }}>
            <input
                placeholder="search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => setFocused(false)}
                onFocus={() => setFocused(true)}
                style={{
                    background: "#1e1f22",
                    borderRadius: 20,
                    border: `1px solid ${focused ? C.brand : "#3f4147"}`,
                    height: 28,
                    boxSizing: "border-box",
                    padding: "0 28px 0 12px",
                    width: "100%",
                    fontSize: 13,
                    color: "#dbdee1",
                    outline: "none",
                    fontFamily: "inherit",
                    transition: "border-color 150ms ease",
                }}
            />
            <div style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                color: "#949ba4",
                display: "flex",
                alignItems: "center",
                pointerEvents: "none",
            }}>
                <ico.search />
            </div>
            {query && (
                <div
                    role="button"
                    onClick={() => setQuery("")}
                    style={{
                        position: "absolute",
                        right: 8,
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: "#949ba4",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        lineHeight: 1,
                    }}
                >
                    <ico.x />
                </div>
            )}
        </div>
    )
}

function previewNotification(uid: string, type: string) {
    const u = UserStore.getUser(uid)
    const label = getWatchedUser(settings, uid)?.nick
    const name = displayName(u) || uid
    const dn = label ? `${label} (${name})` : name
    const icon = u ? avatarUrl(u.id, (u as any).avatar) : undefined

    const previews: Record<string, { title: string; body: string }> = {
        msgs:     { title: `${dn} sent a message`, body: "This is a preview of how message notifications will appear." },
        edits:    { title: `${dn} edited a message`, body: `"before" → "after preview text"` },
        deletes:  { title: `${dn} deleted a message`, body: `"this is a preview of deleted message content"` },
        typing:   { title: `${dn} is typing…`, body: "in #general" },
        status:   { title: `${dn} is now online`, body: "was: offline" },
        activity: { title: `${dn} is playing Game Name`, body: "doing something — details here" },
        voice:    { title: `${dn} joined voice`, body: "#General Voice" },
        joins:    { title: `${dn} joined a server`, body: "Server Name" },
        profile:  { title: `${dn} updated their profile`, body: "bio, display name" },
        avatar:   { title: `${dn} changed their avatar`, body: "click to see new pfp" },
        boosts:   { title: `${dn} boosted a server`, body: "click to view" },
    }

    const p = previews[type] || { title: `${dn}: ${type}`, body: "preview notification" }
    Notifications.showNotification({ title: "[Preview] " + p.title, body: p.body, icon })
}

const ACTIVITY_ICONS: Record<ActivityType, string> = {
    msg: "💬", edit: "✏️", delete: "🗑️", typing: "💭",
    status: "⚪", activity: "🎮", voice: "🎙️",
    join: "📥", leave: "📤", boost: "🚀",
    profile: "👤", avatar: "🖼️", banner: "🏳️", bio: "📝",
    username: "🏷️", displayname: "📛", online: "🟢",
    offline: "⚫", idle: "🌙", dnd: "🔴",
    game_start: "🎮", game_stop: "🛑", spotify: "🎵",
    streaming: "📺", vc_join: "🔊", vc_leave: "🔇", vc_move: "↔️",
    session: "⏱️",
}

function getActivityIcon(entry: ActivityEntry): string {
    const type = entry.type
    const body = entry.body?.toLowerCase() || ""
    const title = entry.title?.toLowerCase() || ""
    const meta = entry.metadata || {}

    if (type === "session") {
        const action = (meta.action || "").toLowerCase()
        if (action.includes("listening") || meta.type === 2 || meta.trackId) return "🎵"
        if (action.includes("voice") || body.includes("voice") || title.includes("voice")) return "🎙️"
        if (action.includes("camera") || body.includes("camera") || title.includes("camera")) return "📷"
        if (action.includes("stream") || action.includes("screen") || body.includes("screen") || title.includes("screen") || body.includes("stream")) return "🖥️"
        if (action.includes("activity") || action.includes("game") || body.includes("game") || title.includes("game")) return "🎮"
        return "⏱️"
    }

    const activityType = meta.type
    const activityName = (meta.name || "").toLowerCase()

    if (activityType === 2 || meta.trackId || body.includes("listening to") || activityName === "spotify") return "🎵"
    if (body.includes("spotify") || title.includes("spotify")) return "🎵"
    if (body.includes("apple music") || title.includes("apple music")) return "🎧"
    if (body.includes("youtube music") || title.includes("youtube music")) return "🎶"
    if (body.includes("soundcloud") || title.includes("soundcloud")) return "☁️"

    if (type === "game_start" || type === "game_stop") return "🎮"
    if (type === "activity" && activityType === 0) return "🎮"

    if (activityType === 1 || body.includes("streaming")) return "📺"
    if (body.includes("twitch") || title.includes("twitch")) return "📺"
    if (body.includes("youtube") || title.includes("youtube")) return "▶️"

    if (type === "status" || type === "online" || type === "offline" || type === "idle" || type === "dnd") {
        if (body.includes("dnd") || title.includes("dnd") || title.includes("do not disturb")) return "🔴"
        if (body.includes("online") || title.includes("online")) return "🟢"
        if (body.includes("idle") || title.includes("idle")) return "🌙"
        if (body.includes("offline") || title.includes("offline")) return "⚫"
        if (entry.icon) return entry.icon
        return "⚪"
    }

    if (body.includes("camera") || body.includes("video")) return "📷"
    if (body.includes("screen") || body.includes("stream")) return "🖥️"
    if (type === "vc_join" || type === "vc_leave" || type === "vc_move") return "🔊"
    if (type === "voice") return "🎙️"

    return ACTIVITY_ICONS[type] || "📌"
}

function formatDuration(ms: number): string {
    if (!ms || ms < 0) return "0m"
    const totalSeconds = Math.floor(ms / 1000)
    const mins = Math.floor(totalSeconds / 60)
    const hours = Math.floor(mins / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) {
        const remainingHours = hours % 24
        const remainingMins = mins % 60
        if (remainingHours > 0 && remainingMins > 0) return `${days}d ${remainingHours}h ${remainingMins}m`
        if (remainingHours > 0) return `${days}d ${remainingHours}h`
        return `${days}d ${remainingMins}m`
    }
    if (hours > 0) {
        const remainingMins = mins % 60
        if (remainingMins > 0) return `${hours}h ${remainingMins}m`
        return `${hours}h`
    }
    if (mins > 0) {
        const remainingSecs = totalSeconds % 60
        if (remainingSecs > 0) return `${mins}m ${remainingSecs}s`
        return `${mins}m`
    }
    return `${totalSeconds}s`
}

const _albumColorCache: Record<string, string> = {}

function extractAlbumColor(imageUrl: string): Promise<string> {
    if (_albumColorCache[imageUrl]) return Promise.resolve(_albumColorCache[imageUrl])
    return new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = "anonymous"
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas")
                const ctx = canvas.getContext("2d")
                if (!ctx) { resolve("#1ed760"); return }
                const size = 64
                canvas.width = size
                canvas.height = size
                ctx.drawImage(img, 0, 0, size, size)
                const data = ctx.getImageData(0, 0, size, size).data

                const buckets: Record<string, { r: number; g: number; b: number; count: number; satSum: number }> = {}
                const bucketSize = 24 // quantize to 24-unit steps

                for (let i = 0; i < data.length; i += 8) { // sample every 2nd pixel for speed
                    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
                    if (a < 128) continue

                    const max = Math.max(r, g, b)
                    const min = Math.min(r, g, b)
                    const lum = (max + min) / 2
                    // Skip near-white, near-black, and very low saturation
                    if (lum < 35 || lum > 240) continue
                    if (max - min < 30) continue // too gray

                    const sat = max === 0 ? 0 : (max - min) / max
                    if (sat < 0.15) continue // skip low saturation

                    const br = Math.floor(r / bucketSize) * bucketSize
                    const bg = Math.floor(g / bucketSize) * bucketSize
                    const bb = Math.floor(b / bucketSize) * bucketSize
                    const key = `${br},${bg},${bb}`

                    if (!buckets[key]) buckets[key] = { r: 0, g: 0, b: 0, count: 0, satSum: 0 }
                    buckets[key].r += r
                    buckets[key].g += g
                    buckets[key].b += b
                    buckets[key].count++
                    buckets[key].satSum += sat
                }


                let bestKey = ""
                let bestScore = 0
                for (const key in buckets) {
                    const b = buckets[key]
                                const avgSat = b.satSum / b.count
                    const score = b.count * avgSat
                    if (score > bestScore) {
                        bestScore = score
                        bestKey = key
                    }
                }

                let hex: string
                if (bestKey && buckets[bestKey]) {
                    const b = buckets[bestKey]
                    const avgR = Math.round(b.r / b.count)
                    const avgG = Math.round(b.g / b.count)
                    const avgB = Math.round(b.b / b.count)
                    hex = `#${avgR.toString(16).padStart(2, "0")}${avgG.toString(16).padStart(2, "0")}${avgB.toString(16).padStart(2, "0")}`
                } else {
                    hex = "#1ed760"
                }

                _albumColorCache[imageUrl] = hex
                resolve(hex)
            } catch {
                resolve("#1ed760")
            }
        }
        img.onerror = () => resolve("#1ed760")
        img.src = imageUrl
    })
}
function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${alpha})`
}

const ACTIVITY_CATEGORIES = [
    { key: "msg" as ActivityType, label: "Messages", Icon: ico.catMsg, color: "#5865f2" },
    { key: "edit" as ActivityType, label: "Edits", Icon: ico.catEdit, color: "#f0b232" },
    { key: "delete" as ActivityType, label: "Deletes", Icon: ico.catDelete, color: "#da373c" },
    { key: "typing" as ActivityType, label: "Typing", Icon: ico.catTyping, color: "#949cf4" },
    { key: "status" as ActivityType, label: "Status", Icon: ico.catStatus, color: "#23a55a" },
    { key: "voice" as ActivityType, label: "Voice", Icon: ico.catVoice, color: "#dbdee1" },
    { key: "profile" as ActivityType, label: "Profile", Icon: ico.catProfile, color: "#ff6b6b" },
    { key: "activity" as ActivityType, label: "Activity", Icon: ico.catActivity, color: "#f0b232" },
] as const

function matchesCategory(log: ActivityEntry, category: ActivityType): boolean {
    if (category === "msg") return log.type === "msg"
    if (category === "edit") return log.type === "edit"
    if (category === "delete") return log.type === "delete"
    if (category === "typing") return log.type === "typing"
    if (category === "status") {
        return log.type === "online" || log.type === "offline" || log.type === "idle" || log.type === "dnd" || log.type === "status"
    }
    if (category === "voice") return log.type === "voice" || log.type === "vc_join" || log.type === "vc_leave" || log.type === "vc_move" || (log.type === "session" && (["voice_session", "stream_session", "camera_session"].includes(log.metadata?.action || "") || (log.metadata?.action || "").includes("voice")))
    if (category === "profile") return log.type === "profile" || log.type === "avatar" || log.type === "banner" || log.type === "bio" || log.type === "username" || log.type === "displayname"
    if (category === "activity") return log.type === "activity" || log.type === "game_start" || log.type === "game_stop" || log.type === "spotify" || log.type === "streaming" || (log.type === "session" && (log.metadata?.action || "").includes("activity"))
    return log.type === category
}

function UserRadarActivityTab({ userId }: { userId: string }) {
    const [logs, setLogs] = React.useState<ActivityEntry[]>([])
    const [activeFilters, setActiveFilters] = React.useState<Set<ActivityType>>(new Set())
    const [expandedId, setExpandedId] = React.useState<string | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [searchQuery, setSearchQuery] = React.useState("")
    const [sortMode, setSortMode] = React.useState<"newest" | "oldest">("newest")

    React.useEffect(() => {
        const load = async () => {
            await activityStore.load()
            setLogs(activityStore.getLogs(userId))
            setLoading(false)
        }
        load()
        const unsub = onActivityUpdate((uid, entry) => {
            if (uid === userId) setLogs(prev => [entry, ...prev])
        })
        return unsub
    }, [userId])

    const toggleFilter = (key: ActivityType) => {
        setActiveFilters(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const clearFilters = () => {
        setActiveFilters(new Set())
    }

    const filtered = React.useMemo(() => {
        let result = logs
        if (activeFilters.size > 0) {
            result = result.filter(l => {
                for (const filter of activeFilters) {
                    if (matchesCategory(l, filter)) return true
                }
                return false
            })
        }
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            result = result.filter(l =>
                l.title.toLowerCase().includes(q) ||
                l.body.toLowerCase().includes(q) ||
                l.type.toLowerCase().includes(q) ||
                (l.metadata?.appName && l.metadata.appName.toLowerCase().includes(q)) ||
                (l.metadata?.song && l.metadata.song.toLowerCase().includes(q)) ||
                (l.metadata?.artist && l.metadata.artist.toLowerCase().includes(q))
            )
        }
        const sorted = [...result]
        if (sortMode === "oldest") sorted.sort((a, b) => a.ts - b.ts)
        return sorted
    }, [logs, activeFilters, searchQuery, sortMode])

    const grouped = React.useMemo(() => {
        return filtered.reduce((acc, log) => {
            const date = new Date(log.ts).toLocaleDateString()
            if (!acc[date]) acc[date] = []
            acc[date].push(log)
            return acc
        }, {} as Record<string, ActivityEntry[]>)
    }, [filtered])

    const categoryCounts = React.useMemo(() => {
        const counts: Record<string, number> = {}
        for (const cat of ACTIVITY_CATEGORIES) {
            counts[cat.key] = logs.filter(l => matchesCategory(l, cat.key)).length
        }
        return counts
    }, [logs])

    if (loading) {
        return (
            <div style={{ padding: 40, textAlign: "center", color: C.muted }}>
                <div className="ur-spin" style={{ width: 24, height: 24, margin: "0 auto 12px" }} />
                <div style={{ fontSize: 13 }}>Loading activity log...</div>
            </div>
        )
    }

    return (
        <div style={{ padding: "0 4px", overflowX: "hidden" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
                <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                    <input
                        placeholder="Search activity..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{
                            background: C.bg1,
                            borderRadius: 20,
                            border: `1px solid ${C.border}`,
                            height: 32,
                            boxSizing: "border-box",
                            padding: "0 32px 0 12px",
                            width: "100%",
                            fontSize: 13,
                            color: C.text,
                            outline: "none",
                            fontFamily: "inherit",
                            transition: "border-color 150ms ease, box-shadow 150ms ease",
                        }}
                        onFocus={e => { e.currentTarget.style.borderColor = C.brand; e.currentTarget.style.boxShadow = `0 0 0 1px ${C.brand}40` }}
                        onBlur={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none" }}
                    />
                    <div style={{
                        position: "absolute",
                        right: 10,
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: C.muted,
                        display: "flex",
                        alignItems: "center",
                        pointerEvents: "none",
                    }}>
                        <ico.search />
                    </div>
                </div>

                <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSortMode(s => s === "newest" ? "oldest" : "newest")}
                    style={{
                        display: "flex", alignItems: "center", gap: 4,
                        padding: "0 10px",
                        borderRadius: 20,
                        cursor: "pointer",
                        background: C.bg1,
                        border: `1px solid ${C.border}`,
                        color: C.muted,
                        fontSize: 11,
                        fontWeight: 600,
                        userSelect: "none",
                        height: 32,
                        boxSizing: "border-box",
                        transition: "all 150ms ease",
                        flexShrink: 0,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = C.bgEl; e.currentTarget.style.color = C.text }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.muted }}
                >
                    {sortMode === "newest" ? <ico.sortDate /> : <ico.sortAz />}
                    {sortMode === "newest" ? "Newest" : "Oldest"}
                </div>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
                {ACTIVITY_CATEGORIES.map(cat => {
                    const isActive = activeFilters.has(cat.key)
                    const count = categoryCounts[cat.key] || 0
                    return (
                        <div
                            key={cat.key}
                            onClick={() => toggleFilter(cat.key)}
                            style={{
                                padding: "5px 10px",
                                borderRadius: 12,
                                background: isActive ? `${cat.color}25` : C.bg1,
                                color: isActive ? cat.color : C.muted,
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                gap: 5,
                                transition: "all 150ms ease",
                                userSelect: "none",
                                border: `1px solid ${isActive ? `${cat.color}60` : C.border}`,
                                opacity: count === 0 ? 0.5 : 1,
                                flexShrink: 0,
                            }}
                            onMouseEnter={e => {
                                if (!isActive) {
                                    e.currentTarget.style.background = "rgba(255,255,255,0.04)"
                                    e.currentTarget.style.color = C.text
                                }
                            }}
                            onMouseLeave={e => {
                                if (!isActive) {
                                    e.currentTarget.style.background = C.bg1
                                    e.currentTarget.style.color = C.muted
                                }
                            }}
                        >
                            <span style={{ display: "flex", alignItems: "center" }}><cat.Icon /></span>
                            <span>{cat.label}</span>
                            <span style={{
                                background: isActive ? `${cat.color}40` : C.bg3,
                                padding: "1px 5px",
                                borderRadius: 6,
                                fontSize: 9,
                                fontWeight: 800,
                                color: isActive ? cat.color : C.muted,
                            }}>
                                {count}
                            </span>
                        </div>
                    )
                })}

                {activeFilters.size > 0 && (
                    <div
                        onClick={clearFilters}
                        style={{
                            padding: "5px 10px",
                            borderRadius: 12,
                            background: "transparent",
                            color: C.muted,
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            transition: "all 150ms ease",
                            userSelect: "none",
                            border: `1px solid ${C.border}`,
                            flexShrink: 0,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = C.danger; e.currentTarget.style.borderColor = C.danger }}
                        onMouseLeave={e => { e.currentTarget.style.color = C.muted; e.currentTarget.style.borderColor = C.border }}
                    >
                        <ico.x />
                        Clear
                    </div>
                )}
            </div>

            <div style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                overflowX: "hidden",
                paddingRight: 4,
            }}>
                {Object.entries(grouped).map(([date, dayLogs]) => (
                    <div key={`${date}-${Array.from(activeFilters).join(",")}-${sortMode}`} style={{ overflowX: "hidden" }}>
                        <div style={{
                            fontSize: 10,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            letterSpacing: 0.8,
                            color: C.muted,
                            marginBottom: 8,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                        }}>
                            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                <ico.calendar />
                                {date === new Date().toLocaleDateString() ? "Today" : date}
                            </span>
                            <span style={{ flex: 1, height: 1, background: C.border }} />
                            <span>{dayLogs.length} events</span>
                        </div>
                        {dayLogs.map(log => (
                            <div
                                key={log.id}
                                onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                                style={{
                                    display: "flex",
                                    gap: 14,
                                    padding: "14px 16px",
                                    borderRadius: 16,
                                    background: C.bg2,
                                    border: `1px solid ${C.border}`,
                                    marginBottom: 6,
                                    cursor: "pointer",
                                    transition: "all 150ms ease",
                                    minHeight: 56,
                                }}
                                onMouseEnter={e => {
                                    e.currentTarget.style.background = "#232428"
                                    e.currentTarget.style.borderColor = C.bgEl
                                }}
                                onMouseLeave={e => {
                                    e.currentTarget.style.background = C.bg2
                                    e.currentTarget.style.borderColor = C.border
                                }}
                            >
                                <div style={{
                                    width: 42,
                                    height: 42,
                                    borderRadius: 12,
                                    background: C.bg1,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: 20,
                                    flexShrink: 0,
                                    border: `1px solid ${C.border}`,
                                    marginTop: 1,
                                }}>
                                    {(() => {
                                        const ic = getActivityIcon(log)
                                        return typeof ic === "string" && (ic.startsWith("http") || ic.startsWith("/"))
                                            ? <img src={ic} style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover" }} onError={(e: any) => { e.target.style.display = "none" }} />
                                            : ic
                                    })()}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{
                                        fontSize: log.type === "msg" || log.type === "edit" || log.type === "delete" ? 15 : 14,
                                        fontWeight: 800,
                                        color: C.header,
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                        marginBottom: 4,
                                    }}>
                                        <span style={{ wordBreak: "break-word", flex: 1, minWidth: 0 }}>
                                            {log.title}
                                        </span>
                                        <span style={{
                                            fontSize: 12,
                                            color: C.subheader,
                                            fontWeight: 700,
                                            background: C.bg1,
                                            padding: "4px 10px",
                                            borderRadius: 8,
                                            border: `1px solid ${C.border}`,
                                            flexShrink: 0,
                                            whiteSpace: "nowrap",
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 6,
                                        }} title={exactTime(log.ts)}>
                                            <span style={{ display: "flex", alignItems: "center" }}><ico.clock /></span>
                                            {new Date(log.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}
                                            <span style={{ color: C.muted, fontWeight: 500 }}>· {timeAgo(log.ts)}</span>
                                        </span>
                                        <div
                                            role="button"
                                            title="Delete this entry"
                                            onClick={async (e) => {
                                                e.stopPropagation()
                                                if (!confirm("Delete this activity entry?")) return
                                                await activityStore.removeLog(userId, log.id)
                                                setLogs(prev => prev.filter(l => l.id !== log.id))
                                            }}
                                            style={{
                                                padding: "4px 8px",
                                                borderRadius: 6,
                                                cursor: "pointer",
                                                background: "transparent",
                                                color: C.muted,
                                                fontSize: 11,
                                                fontWeight: 700,
                                                display: "flex",
                                                alignItems: "center",
                                                opacity: 0.4,
                                                transition: "opacity 150ms ease, background 150ms ease, color 150ms ease",
                                            }}
                                            onMouseEnter={e => {
                                                e.currentTarget.style.opacity = "1"
                                                e.currentTarget.style.background = "rgba(218,55,60,0.12)"
                                                e.currentTarget.style.color = C.red
                                            }}
                                            onMouseLeave={e => {
                                                e.currentTarget.style.opacity = "0.4"
                                                e.currentTarget.style.background = "transparent"
                                                e.currentTarget.style.color = C.muted
                                            }}
                                        >
                                            <ico.trash />
                                        </div>
                                    </div>
                                    {log.body && log.body !== log.title && log.type !== "activity" && log.type !== "session" && log.metadata?.action !== "status_session" && (
                                        <div style={{
                                            fontSize: log.type === "msg" || log.type === "edit" || log.type === "delete" ? 14 : 13,
                                            color: log.type === "msg" || log.type === "edit" || log.type === "delete" ? C.text : C.muted,
                                            lineHeight: 1.4,
                                            wordBreak: "break-word",
                                            fontWeight: log.type === "msg" || log.type === "edit" || log.type === "delete" ? 500 : 400,
                                            marginTop: log.type === "msg" || log.type === "edit" || log.type === "delete" ? 2 : 0,
                                        }}>
                                            {log.body}
                                        </div>
                                    )}
                                    {(log.type === "msg" || log.type === "edit" || log.type === "delete" || log.type === "voice" || log.type === "activity" || (log.type === "session" && ["listening_session", "activity_session", "voice_session", "camera_session", "stream_session"].includes(log.metadata?.action))) && (
                                        <div style={{
                                            fontSize: 11,
                                            color: C.subheader,
                                            marginTop: 4,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 5,
                                        }}>
                                            <span style={{ opacity: 0.5, display: "flex", alignItems: "center" }}><ico.location /></span>
                                            <span>
                                                {log.metadata?.appName || log.metadata?.server || "Unknown"}
                                                {log.metadata?.channel ? ` · #${log.metadata.channel}` : ""}
                                                {log.metadata?.duration ? ` · ${log.metadata.duration}` : ""}
                                            </span>
                                        </div>
                                    )}
                                    {log.type === "session" && log.metadata?.action === "status_session" && (
                                        <div style={{
                                            fontSize: 11,
                                            color: C.subheader,
                                            marginTop: 4,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 5,
                                        }}>
                                            <span style={{ opacity: 0.5, display: "flex", alignItems: "center" }}><ico.status /></span>
                                            <span>
                                                {log.metadata?.platform ? `${CLIENT_EMOJI[log.metadata.platform.toLowerCase()] || "📡"} ${log.metadata.platform}` : "Status session"}
                                                {log.metadata?.duration ? ` · ${log.metadata.duration}` : ""}
                                            </span>
                                        </div>
                                    )}
                                    {log.type === "edit" && log.metadata?.before && (
                                        <div style={{
                                            marginTop: 10,
                                            padding: "10px 14px",
                                            background: "rgba(240,178,50,0.08)",
                                            borderRadius: 14,
                                            fontSize: 12,
                                            color: C.text,
                                            border: `1px solid rgba(240,178,50,0.25)`,
                                            lineHeight: 1.5,
                                        }}>
                                            <div style={{ fontSize: 10, fontWeight: 800, color: "#f0b232", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.6, display: "flex", alignItems: "center", gap: 6 }}>
                                                <ico.edit />
                                                Previous Version
                                            </div>
                                            <span style={{
                                                textDecoration: "line-through",
                                                opacity: 0.7,
                                                wordBreak: "break-word",
                                            }}>{trunc(log.metadata.before, 200)}</span>
                                        </div>
                                    )}
                                    {expandedId === log.id && (
                                        <div>
                                            {(log.channelId || log.guildId) && (
                                                <div
                                                    onClick={(e) => { e.stopPropagation(); jumpTo(log.guildId, log.channelId, log.msgId) }}
                                                    style={{
                                                        marginTop: 10,
                                                        padding: "10px 16px",
                                                        background: C.brand,
                                                        borderRadius: 10,
                                                        color: C.white,
                                                        fontSize: 13,
                                                        fontWeight: 700,
                                                        cursor: "pointer",
                                                        textAlign: "center",
                                                        fontFamily: "inherit",
                                                        transition: "background 150ms ease",
                                                        display: "flex",
                                                        alignItems: "center",
                                                        justifyContent: "center",
                                                        gap: 6,
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.background = "#4752c4" }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = C.brand }}
                                                >
                                                    <ico.external />
                                                    Jump to Discord
                                                </div>
                                            )}
                                            {log.metadata && log.type !== "msg" && log.type !== "edit" && log.type !== "delete" && (
                                                <div style={{
                                                    marginTop: 10,
                                                    padding: "12px 16px",
                                                    background: C.bg1,
                                                    borderRadius: 12,
                                                    fontSize: 12,
                                                    color: C.muted,
                                                    lineHeight: 1.6,
                                                    border: `1px solid ${C.border}`,
                                                }}>
                                                    {log.metadata.song && (
                                                        <div
                                                            ref={(el: any) => {
                                                                if (!el || !log.metadata.albumArtUrl) return
                                                                const cached = _albumColorCache[log.metadata.albumArtUrl]
                                                                if (cached) {
                                                                    el.style.background = hexToRgba(cached, 0.06)
                                                                    el.style.borderColor = hexToRgba(cached, 0.35)
                                                                    return
                                                                }
                                                                extractAlbumColor(log.metadata.albumArtUrl).then((hex: string) => {
                                                                    if (el) {
                                                                        el.style.background = hexToRgba(hex, 0.06)
                                                                        el.style.borderColor = hexToRgba(hex, 0.35)
                                                                    }
                                                                })
                                                            }}
                                                            style={{
                                                                display: "flex",
                                                                gap: 0,
                                                                marginBottom: 12,
                                                                borderRadius: 10,
                                                                border: "1px solid rgba(30,215,96,0.2)",
                                                                overflow: "hidden",
                                                                background: "rgba(30,215,96,0.06)",
                                                                transition: "background 300ms ease, border-color 300ms ease",
                                                                position: "relative",
                                                                minHeight: 160,
                                                            }}
                                                        >
                                                            {log.metadata.albumArtUrl && (
                                                                <div style={{
                                                                    position: "relative",
                                                                    width: 160,
                                                                    height: 160,
                                                                    overflow: "hidden",
                                                                    borderRadius: 10,
                                                                    flexShrink: 0,
                                                                    alignSelf: "center",
                                                                }}>
                                                                    <img
                                                                        src={log.metadata.albumArtUrl}
                                                                        style={{
                                                                            position: "absolute",
                                                                            top: 0,
                                                                            left: 0,
                                                                            width: "100%",
                                                                            height: "100%",
                                                                            objectFit: "cover",
                                                                            display: "block",
                                                                            borderRadius: 8,
                                                                        }}
                                                                        onError={(e: any) => { e.target.style.display = "none" }}
                                                                    />
                                                                    <div style={{
                                                                        position: "absolute",
                                                                        top: 0,
                                                                        right: 0,
                                                                        width: 50,
                                                                        height: "100%",
                                                                        background: "linear-gradient(to right, transparent, rgba(0,0,0,0.4))",
                                                                        pointerEvents: "none",
                                                                    }} />
                                                                </div>
                                                            )}
                                                            <div style={{
                                                                flex: 1,
                                                                minWidth: 0,
                                                                display: "flex",
                                                                flexDirection: "column",
                                                                justifyContent: "center",
                                                                padding: "14px 16px",
                                                                gap: 1,
                                                            }}>
                                                                {log.metadata.appName && (
                                                                    <div style={{
                                                                        fontSize: 10,
                                                                        fontWeight: 800,
                                                                        textTransform: "uppercase",
                                                                        letterSpacing: 0.8,
                                                                        color: C.brandLight,
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        gap: 5,
                                                                        marginBottom: 4,
                                                                    }}>
                                                                        {log.metadata.appName === "Spotify" && <span>🎵</span>}
                                                                        {log.metadata.appName}
                                                                    </div>
                                                                )}
                                                                <div style={{
                                                                    fontSize: 16,
                                                                    fontWeight: 800,
                                                                    color: C.header,
                                                                    whiteSpace: "nowrap",
                                                                    overflow: "hidden",
                                                                    textOverflow: "ellipsis",
                                                                    lineHeight: 1.2,
                                                                    letterSpacing: -0.2,
                                                                }}>
                                                                    {log.metadata.song}
                                                                </div>
                                                                {log.metadata.artist && (
                                                                    <div style={{
                                                                        fontSize: 14,
                                                                        color: C.text,
                                                                        whiteSpace: "nowrap",
                                                                        overflow: "hidden",
                                                                        textOverflow: "ellipsis",
                                                                        fontWeight: 500,
                                                                        marginTop: 2,
                                                                    }}>
                                                                        {log.metadata.artist}
                                                                    </div>
                                                                )}
                                                                {log.metadata.album && (
                                                                    <div style={{
                                                                        fontSize: 12,
                                                                        color: C.muted,
                                                                        whiteSpace: "nowrap",
                                                                        overflow: "hidden",
                                                                        textOverflow: "ellipsis",
                                                                        marginTop: 1,
                                                                    }}>
                                                                        {log.metadata.album}
                                                                    </div>
                                                                )}
                                                                <div style={{
                                                                    display: "flex",
                                                                    gap: 6,
                                                                    marginTop: 8,
                                                                    flexWrap: "wrap",
                                                                    alignItems: "center",
                                                                }}>
                                                                    {Array.isArray(log.metadata.allArtists) && log.metadata.allArtists.length > 1 && (
                                                                        <span style={{
                                                                            fontSize: 10,
                                                                            color: C.muted,
                                                                            background: "rgba(0,0,0,0.25)",
                                                                            padding: "2px 8px",
                                                                            borderRadius: 10,
                                                                            fontWeight: 600,
                                                                        }} title={`All artists: ${log.metadata.allArtists.join(", ")}`}>
                                                                            +{log.metadata.allArtists.length - 1} more
                                                                        </span>
                                                                    )}
                                                                    {log.metadata.contextUri && (
                                                                        <span style={{
                                                                            fontSize: 10,
                                                                            color: C.muted,
                                                                            background: "rgba(0,0,0,0.25)",
                                                                            padding: "2px 8px",
                                                                            borderRadius: 10,
                                                                            fontWeight: 600,
                                                                        }} title={log.metadata.contextUri}>
                                                                            {log.metadata.contextUri.includes("playlist") ? "🎶 Playlist" : log.metadata.contextUri.includes("album") ? "💿 Album" : "🎵 Context"}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                {(log.metadata.startTimestamp && log.metadata.endTimestamp) && (() => {
                                                                    const total = log.metadata.endTimestamp - log.metadata.startTimestamp
                                                                    const totalStr = formatDuration(total)
                                                                    return (
                                                                        <div style={{ marginTop: 12 }}>
                                                                            <div style={{
                                                                                height: 4,
                                                                                background: "rgba(0,0,0,0.3)",
                                                                                borderRadius: 2,
                                                                                overflow: "hidden",
                                                                            }}>
                                                                                <div style={{
                                                                                    width: "100%",
                                                                                    height: "100%",
                                                                                    background: C.brandLight,
                                                                                    borderRadius: 2,
                                                                                    opacity: 0.5,
                                                                                }} />
                                                                            </div>
                                                                            <div style={{
                                                                                display: "flex",
                                                                                justifyContent: "flex-end",
                                                                                marginTop: 5,
                                                                                fontSize: 11,
                                                                                color: C.muted,
                                                                                fontWeight: 600,
                                                                                letterSpacing: 0.3,
                                                                            }}>
                                                                                {totalStr}
                                                                            </div>
                                                                        </div>
                                                                    )
                                                                })()}
                                                            </div>
                                                        </div>
                                                    )}
                                                    {log.metadata.gameIconUrl && !log.metadata.song && (
                                                        <div style={{
                                                            display: "flex",
                                                            gap: 12,
                                                            marginBottom: 12,
                                                            padding: "10px 12px",
                                                            background: "rgba(88,101,242,0.08)",
                                                            borderRadius: 10,
                                                            border: "1px solid rgba(88,101,242,0.2)",
                                                        }}>
                                                            <img
                                                                src={log.metadata.gameIconUrl}
                                                                style={{
                                                                    width: 56, height: 56,
                                                                    borderRadius: 12,
                                                                    objectFit: "cover",
                                                                    flexShrink: 0,
                                                                    border: `1px solid ${C.border}`,
                                                                }}
                                                                onError={(e: any) => { e.target.style.display = "none" }}
                                                            />
                                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                                {log.metadata.appName && (
                                                                    <div style={{
                                                                        fontSize: 9,
                                                                        fontWeight: 800,
                                                                        textTransform: "uppercase",
                                                                        letterSpacing: 0.6,
                                                                        color: C.brandLight,
                                                                        marginBottom: 3,
                                                                    }}>
                                                                        {log.metadata.appName}
                                                                    </div>
                                                                )}
                                                                {log.metadata.details && (
                                                                    <div style={{
                                                                        fontSize: 13,
                                                                        fontWeight: 800,
                                                                        color: C.header,
                                                                        marginBottom: 2,
                                                                        whiteSpace: "nowrap",
                                                                        overflow: "hidden",
                                                                        textOverflow: "ellipsis",
                                                                    }}>
                                                                        {log.metadata.details}
                                                                    </div>
                                                                )}
                                                                {log.metadata.state && (
                                                                    <div style={{
                                                                        fontSize: 11,
                                                                        color: C.muted,
                                                                        whiteSpace: "nowrap",
                                                                        overflow: "hidden",
                                                                        textOverflow: "ellipsis",
                                                                    }}>
                                                                        {log.metadata.state}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}
                                                    {log.metadata.duration && (
                                                        <div style={{
                                                            marginBottom: 10,
                                                            padding: "10px 14px",
                                                            background: C.bg1,
                                                            borderRadius: 10,
                                                            border: `1px solid ${C.border}`,
                                                        }}>
                                                            <div style={{
                                                                display: "flex",
                                                                alignItems: "center",
                                                                gap: 8,
                                                                marginBottom: 8,
                                                            }}>
                                                                <span style={{
                                                                    display: "flex",
                                                                    alignItems: "center",
                                                                    color: C.brandLight,
                                                                }}><ico.clock /></span>
                                                                <span style={{ color: C.brandLight, fontWeight: 800, fontSize: 13 }}>
                                                                    {log.metadata.duration}
                                                                </span>
                                                            </div>

                                                            {log.metadata.startTime && (
                                                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                                                        <div style={{
                                                                            width: 8, height: 8, borderRadius: "50%",
                                                                            background: C.green,
                                                                            flexShrink: 0,
                                                                            boxShadow: `0 0 0 3px ${C.green}30`,
                                                                        }} />
                                                                        <div style={{ flex: 1 }}>
                                                                            <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>
                                                                                {log.metadata.action === "status_session" ? "Online" :
                                                                                 log.metadata.action === "activity_session" || log.metadata.action === "listening_session" ? "Started" : "Joined"}
                                                                            </div>
                                                                            <div style={{ fontSize: 12, color: C.text, fontWeight: 700 }}>
                                                                                {new Date(log.metadata.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
                                                                                <span style={{ color: C.muted, fontWeight: 500, marginLeft: 6 }}>
                                                                                    {new Date(log.metadata.startTime).toLocaleDateString([], { month: "short", day: "numeric" })}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    </div>

                                                                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 3 }}>
                                                                        <div style={{ width: 2, height: 20, background: `linear-gradient(to bottom, ${C.green}, ${C.red})`, borderRadius: 1 }} />
                                                                        <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic" }}>
                                                                            {log.metadata.duration}
                                                                        </div>
                                                                    </div>

                                                                    {log.metadata.endTime && (
                                                                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                                                            <div style={{
                                                                                width: 8, height: 8, borderRadius: "50%",
                                                                                background: C.red,
                                                                                flexShrink: 0,
                                                                                boxShadow: `0 0 0 3px ${C.red}30`,
                                                                            }} />
                                                                            <div style={{ flex: 1 }}>
                                                                                <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>
                                                                                    {log.metadata.action === "status_session" ? "Offline" :
                                                                                     log.metadata.action === "activity_session" || log.metadata.action === "listening_session" ? "Stopped" : "Left"}
                                                                                </div>
                                                                                <div style={{ fontSize: 12, color: C.text, fontWeight: 700 }}>
                                                                                    {new Date(log.metadata.endTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
                                                                                    <span style={{ color: C.muted, fontWeight: 500, marginLeft: 6 }}>
                                                                                        {new Date(log.metadata.endTime).toLocaleDateString([], { month: "short", day: "numeric" })}
                                                                                    </span>
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    )}

                                                                    {!log.metadata.endTime && (
                                                                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                                                            <div style={{
                                                                                width: 8, height: 8, borderRadius: "50%",
                                                                                background: C.brand,
                                                                                flexShrink: 0,
                                                                                animation: "ur-pulse 2s infinite",
                                                                            }} />
                                                                            <div style={{ fontSize: 12, color: C.brandLight, fontWeight: 700 }}>
                                                                                Still active…
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                    {log.metadata.action === "status_session" && Array.isArray(log.metadata.statusTimeline) && log.metadata.statusTimeline.length > 0 && (
                                                        <div style={{
                                                            marginBottom: 10,
                                                            padding: "12px 14px",
                                                            background: C.bg1,
                                                            borderRadius: 10,
                                                            border: `1px solid ${C.border}`,
                                                        }}>
                                                            <div style={{
                                                                fontSize: 10,
                                                                fontWeight: 800,
                                                                textTransform: "uppercase",
                                                                letterSpacing: 0.8,
                                                                color: C.subheader,
                                                                marginBottom: 10,
                                                                display: "flex",
                                                                alignItems: "center",
                                                                gap: 6,
                                                            }}>
                                                                <span style={{ display: "flex", alignItems: "center" }}><ico.status /></span>
                                                                Status Timeline
                                                            </div>
                                                            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                                                                {log.metadata.statusTimeline.map((ch: any, i: number) => (
                                                                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
                                                                        <div style={{
                                                                            width: 10, height: 10, borderRadius: "50%",
                                                                            background: ch.status === "online" ? "#23a55a" : ch.status === "idle" ? "#f0b232" : ch.status === "dnd" ? "#da373c" : "#80848e",
                                                                            flexShrink: 0,
                                                                            boxShadow: `0 0 0 3px ${ch.status === "online" ? "#23a55a30" : ch.status === "idle" ? "#f0b23230" : ch.status === "dnd" ? "#da373c30" : "#80848e30"}`,
                                                                        }} />
                                                                        {i < log.metadata.statusTimeline.length - 1 && (
                                                                            <div style={{
                                                                                position: "absolute",
                                                                                left: 4,
                                                                                top: 14,
                                                                                width: 2,
                                                                                height: 24,
                                                                                background: C.border,
                                                                                borderRadius: 1,
                                                                            }} />
                                                                        )}
                                                                        <div style={{ flex: 1, minWidth: 0, paddingBottom: i < log.metadata.statusTimeline.length - 1 ? 8 : 0 }}>
                                                                            <div style={{
                                                                                display: "flex",
                                                                                alignItems: "center",
                                                                                gap: 6,
                                                                                flexWrap: "wrap",
                                                                            }}>
                                                                                <span style={{
                                                                                    fontSize: 12,
                                                                                    fontWeight: 700,
                                                                                    color: C.header,
                                                                                }}>
                                                                                    {ch.emoji} {ch.label}
                                                                                </span>
                                                                                <span style={{
                                                                                    fontSize: 10,
                                                                                    color: C.muted,
                                                                                    fontFamily: "monospace",
                                                                                    marginLeft: "auto",
                                                                                }}>
                                                                                    {ch.time}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                            {Array.isArray(log.metadata.platformTimeline) && log.metadata.platformTimeline.length > 0 && (
                                                                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                                                                    <div style={{
                                                                        fontSize: 10,
                                                                        fontWeight: 800,
                                                                        textTransform: "uppercase",
                                                                        letterSpacing: 0.8,
                                                                        color: C.subheader,
                                                                        marginBottom: 8,
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        gap: 6,
                                                                    }}>
                                                                        <span style={{ display: "flex", alignItems: "center" }}><ico.activity /></span>
                                                                        Platform Changes
                                                                    </div>
                                                                    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                                                                        {log.metadata.platformTimeline.map((pt: any, i: number) => (
                                                                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
                                                                                <div style={{
                                                                                    width: 10, height: 10, borderRadius: "50%",
                                                                                    background: C.brandLight,
                                                                                    flexShrink: 0,
                                                                                    boxShadow: `0 0 0 3px ${C.brandLight}30`,
                                                                                }} />
                                                                                {i < log.metadata.platformTimeline.length - 1 && (
                                                                                    <div style={{
                                                                                        position: "absolute",
                                                                                        left: 4,
                                                                                        top: 14,
                                                                                        width: 2,
                                                                                        height: 24,
                                                                                        background: C.border,
                                                                                        borderRadius: 1,
                                                                                    }} />
                                                                                )}
                                                                                <div style={{ flex: 1, minWidth: 0, paddingBottom: i < log.metadata.platformTimeline.length - 1 ? 8 : 0 }}>
                                                                                    <div style={{
                                                                                        display: "flex",
                                                                                        alignItems: "center",
                                                                                        gap: 6,
                                                                                        flexWrap: "wrap",
                                                                                    }}>
                                                                                        <span style={{
                                                                                            fontSize: 12,
                                                                                            fontWeight: 700,
                                                                                            color: C.header,
                                                                                        }}>
                                                                                            {CLIENT_EMOJI[pt.platform.toLowerCase()] || "📡"} {CLIENT_LABEL_MAP[pt.platform] || pt.platform}
                                                                                        </span>
                                                                                        <span style={{
                                                                                            fontSize: 10,
                                                                                            color: C.muted,
                                                                                            fontFamily: "monospace",
                                                                                            marginLeft: "auto",
                                                                                        }}>
                                                                                            {pt.time}
                                                                                        </span>
                                                                                    </div>
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}
                                                            <div style={{
                                                                marginTop: 10,
                                                                paddingTop: 8,
                                                                borderTop: `1px solid ${C.border}`,
                                                                display: "flex",
                                                                alignItems: "center",
                                                                justifyContent: "space-between",
                                                            }}>
                                                                <span style={{ fontSize: 10, color: C.muted }}>
                                                                    Started {new Date(log.metadata.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
                                                                </span>
                                                                <span style={{
                                                                    fontSize: 10,
                                                                    fontWeight: 800,
                                                                    color: C.brandLight,
                                                                    background: "rgba(88,101,242,0.1)",
                                                                    padding: "2px 8px",
                                                                    borderRadius: 6,
                                                                }}>
                                                                    {log.metadata.duration}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {log.metadata.platform && (
                                                        <div style={{
                                                            display: "flex",
                                                            gap: 10,
                                                            marginBottom: 8,
                                                            alignItems: "center",
                                                            padding: "6px 10px",
                                                            background: C.bg2,
                                                            borderRadius: 8,
                                                            border: `1px solid ${C.border}`,
                                                        }}>
                                                            <span style={{ color: C.brandLight, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Platform</span>
                                                            <span style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>
                                                                {CLIENT_EMOJI[log.metadata.platformKey || String(log.metadata.platform).toLowerCase()] || "📡"} {CLIENT_LABEL_MAP[log.metadata.platform] || log.metadata.platform}
                                                            </span>
                                                        </div>
                                                    )}
                                                    {Object.entries(log.metadata)
                                                        .filter(([key, val]) =>
                                                            !["duration","startTime","endTime","members","metadata","type","action","name","song","artist","allArtists","album","trackId","albumId","artistIds","contextUri","trackType","albumArtUrl","largeImage","smallImage","smallText","statusDisplayType","createdAt","sessionId","partyId","partySize","appName","appLogo","gameIconUrl","applicationId","parentApplicationId","platform","platformKey","flags","buttons","secrets","url","startTimestamp","endTimestamp","timestamps","party","assets","statusTimeline","platformTimeline","startStatus","endStatus","changeCount"].includes(key) &&
                                                            val !== undefined && val !== null && val !== "" &&
                                                            !(typeof val === "object" && Object.keys(val).length === 0)
                                                        )
                                                        .map(([key, val]) => (
                                                        <div key={key} style={{
                                                            display: "flex",
                                                            gap: 10,
                                                            marginBottom: 6,
                                                            alignItems: "center",
                                                            padding: "6px 10px",
                                                            background: C.bg2,
                                                            borderRadius: 8,
                                                            border: `1px solid ${C.border}`,
                                                        }}>
                                                            <span style={{
                                                                color: C.brandLight,
                                                                minWidth: 80,
                                                                fontWeight: 700,
                                                                fontSize: 11,
                                                                textTransform: "uppercase",
                                                                letterSpacing: 0.5
                                                            }}>{key}</span>
                                                            <span style={{
                                                                color: C.text,
                                                                wordBreak: "break-word",
                                                                flex: 1,
                                                                fontSize: 12,
                                                                fontWeight: 600,
                                                            }}>
                                                                {typeof val === "object" ? JSON.stringify(val) : String(val)}
                                                            </span>
                                                        </div>
                                                    ))}
                                                    {Array.isArray(log.metadata.members) && log.metadata.members.length > 0 && (
                                                        <div style={{ display: "flex", gap: 10, marginBottom: 4, alignItems: "baseline" }}>
                                                            <span style={{ color: C.brandLight, minWidth: 80, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>WITH</span>
                                                            <span style={{ color: C.text, flex: 1, wordBreak: "break-word" }}>{(log.metadata.members as string[]).join(", ")}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                            </div>
                        ))}
                    </div>
                ))}
                {logs.length === 0 && (
                    <div style={{ textAlign: "center", padding: "40px 0", color: C.muted }}>
                        <div style={{
                            width: 56,
                            height: 56,
                            borderRadius: "50%",
                            background: C.bg1,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            margin: "0 auto 14px",
                            border: `1px solid ${C.border}`,
                        }}>
                            <ico.ghost />
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.header }}>No activity tracked yet</div>
                        <div style={{ fontSize: 12, marginTop: 4, color: C.muted }}>Events will appear here once this user does something</div>
                    </div>
                )}
                {logs.length > 0 && filtered.length === 0 && (
                    <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
                        <div style={{ display: "flex", justifyContent: "center", marginBottom: 10, opacity: 0.5 }}>
                            <ico.search />
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>No matching events</div>
                        <div style={{ fontSize: 11, marginTop: 3 }}>Try adjusting your filters or search</div>
                    </div>
                )}
            </div>

                    </div>
    )
}

// activity count badge

function ActivityLogFooter({ userId, onRefresh }: { userId: string; onRefresh?: () => void }) {
    const [count, setCount] = React.useState(0)

    React.useEffect(() => {
        const load = async () => {
            await activityStore.load()
            setCount(activityStore.getLogs(userId).length)
        }
        load()
        const unsub = onActivityUpdate((uid) => {
            if (uid === userId) setCount(activityStore.getLogs(userId).length)
        })
        return unsub
    }, [userId])

    return (
        <div style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            alignItems: "center",
            width: "100%",
        }}>
            <span style={{ fontSize: 11, color: C.muted, marginRight: "auto" }}>
                {count} total events logged
            </span>
            <button
                onClick={() => {
                    const input = document.createElement("input")
                    input.type = "file"
                    input.accept = ".json"
                    input.onchange = async (e: any) => {
                        const file = e.target.files[0]
                        if (!file) return
                        const text = await file.text()
                        const ok = await activityStore.importAll(text)
                        if (ok) {
                            onRefresh?.()
                            Toasts.show({
                                message: `Imported activity log`,
                                id: Toasts.genId(),
                                type: Toasts.Type.SUCCESS,
                            })
                        } else {
                            Toasts.show({
                                message: "Failed to import — invalid JSON file",
                                id: Toasts.genId(),
                                type: Toasts.Type.FAILURE,
                            })
                        }
                    }
                    input.click()
                }}
                style={{
                    padding: "8px 16px",
                    borderRadius: 20,
                    background: C.bg1,
                    border: `1px solid ${C.border}`,
                    color: C.text,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 150ms ease",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.bgEl; e.currentTarget.style.background = C.bg2 }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.bg1 }}
            >
                <ico.download />
                Import
            </button>
            <button
                onClick={() => {
                    if (count === 0) {
                        Toasts.show({
                            message: "No activity to export",
                            id: Toasts.genId(),
                            type: Toasts.Type.FAILURE,
                        })
                        return
                    }
                    const data = activityStore.exportAll()
                    const blob = new Blob([data], { type: "application/json" })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = `userradar_${userId}_${new Date().toISOString().slice(0,10)}.json`
                    a.click()
                    URL.revokeObjectURL(url)
                }}
                style={{
                    padding: "8px 16px",
                    borderRadius: 20,
                    background: C.bg1,
                    border: `1px solid ${C.border}`,
                    color: C.text,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 150ms ease",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.bgEl; e.currentTarget.style.background = C.bg2 }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.bg1 }}
            >
                <ico.upload />
                Export
            </button>
            <button
                onClick={async () => {
                    if (count === 0) {
                        Toasts.show({
                            message: "No activity to clear",
                            id: Toasts.genId(),
                            type: Toasts.Type.FAILURE,
                        })
                        return
                    }
                    if (confirm("Clear all history for this user? This cannot be undone.")) {
                        await activityStore.clearLogs(userId)
                        onRefresh?.()
                    }
                }}
                style={{
                    padding: "8px 16px",
                    borderRadius: 20,
                    background: "rgba(218,55,60,0.08)",
                    border: `1px solid ${C.red}`,
                    color: C.red,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 150ms ease",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(218,55,60,0.15)" }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(218,55,60,0.08)" }}
            >
                <ico.clear />
                Clear
            </button>
        </div>
    )
}

function ActivityBadge({ userId }: { userId: string }) {
    const [count, setCount] = React.useState(0)
    const [loaded, setLoaded] = React.useState(false)

    React.useEffect(() => {
        let mounted = true
        const load = async () => {
            await activityStore.load()
            if (mounted) {
                setCount(activityStore.getLogs(userId).length)
                setLoaded(true)
            }
        }
        load()
        const unsub = onActivityUpdate((uid) => {
            if (uid === userId && mounted) {
                setCount(activityStore.getLogs(userId).length)
            }
        })
        return () => { mounted = false; unsub() }
    }, [userId])

    return (
        <span style={{
            fontSize: 10,
            fontWeight: 800,
            background: count > 0 ? C.brand : loaded ? C.bg3 : C.bg1,
            padding: "2px 6px",
            borderRadius: 6,
            color: count > 0 ? C.white : loaded ? C.muted : "transparent",
            minWidth: 18,
            textAlign: "center",
            lineHeight: 1,
            transition: "all 150ms ease",
        }}>
            {loaded ? count : ""}
        </span>
    )
}

function WatchedRow({ user, refresh, expandedId, setExpandedId, onRemove }: {
    user: WatchedUser
    refresh: () => void
    expandedId: string | null
    setExpandedId: (id: string | null) => void
    onRemove: () => void
}) {
    const [nick,     setNick] = React.useState(user.nick || "")
    const expanded = expandedId === user.id
    const setExp = (v: boolean) => setExpandedId(v ? user.id : null)
    const [copied,   setCopy] = React.useState(false)
    const [ovTab,    setOvTab] = React.useState<OvTab>("messages")

    const du   = UserStore.getUser(user.id)
    const name = displayName(du) || user.id
    const av   = du ? avatarUrl(du.id, (du as any).avatar, 64) : avatarUrl(user.id, null, 64)

    const saveNick = () => { patchUser(settings, user.id, { nick: nick || "" }); refresh() }
    const setOv = (key: keyof WatchedUser["overrides"], val: boolean | null) => {
        patchUser(settings, user.id, { overrides: { ...user.overrides, [key]: val } })
        refresh()
        const label = getWatchedUser(settings, user.id)?.nick
        const u = UserStore.getUser(user.id)
        const name = displayName(u) || user.id
        const dn = label ? `${label} (${name})` : name
        const featLabel = OV_GROUPS.messages.find(r => r.key === key)?.label
            || OV_GROUPS.presence.find(r => r.key === key)?.label
            || OV_GROUPS.profile.find(r => r.key === key)?.label
            || key
        if (val === true) {
            Toasts.show({ type: Toasts.Type.SUCCESS, message: `${dn}: ${featLabel} enabled`, id: Toasts.genId() })
        } else if (val === false) {
            Toasts.show({ type: Toasts.Type.DEFAULT, message: `${dn}: ${featLabel} disabled`, id: Toasts.genId() })
        } else if (val === null) {
            Toasts.show({ type: Toasts.Type.SUCCESS, message: `${dn}: ${featLabel} reset to global`, id: Toasts.genId() })
        }
    }

    const copyId = () => {
        navigator.clipboard.writeText(user.id)
        setCopy(true)
        setTimeout(() => setCopy(false), 1200)
    }

    const resetAll = () => {
        const list = getWatchlist(settings)
        const idx = list.findIndex(u => u.id === user.id)
        if (idx === -1) return
        const newOverrides: any = {}
        Object.keys(OV_GROUPS).forEach(g => {
            OV_GROUPS[g as OvTab].forEach(r => {
                newOverrides[r.key] = null
            })
        })
        list[idx] = { ...list[idx], overrides: newOverrides }
        settings.store.watchlist = JSON.stringify(list)
        refresh()
        const label = getWatchedUser(settings, user.id)?.nick
        const u = UserStore.getUser(user.id)
        const name = displayName(u) || user.id
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `${label ? `${label} (${name})` : name}: all overrides reset`, id: Toasts.genId() })
    }

    const enableAll = () => {
        const list = getWatchlist(settings)
        const idx = list.findIndex(u => u.id === user.id)
        if (idx === -1) return
        const newOverrides: any = { ...list[idx].overrides }
        OV_GROUPS[ovTab].forEach(r => {
            newOverrides[r.key] = true
        })
        list[idx] = { ...list[idx], overrides: newOverrides }
        settings.store.watchlist = JSON.stringify(list)
        refresh()
        const label = getWatchedUser(settings, user.id)?.nick
        const u = UserStore.getUser(user.id)
        const name = displayName(u) || user.id
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `${label ? `${label} (${name})` : name}: all ${OV_TAB_LABELS[ovTab]} enabled`, id: Toasts.genId() })
    }

    const disableAll = () => {
        const list = getWatchlist(settings)
        const idx = list.findIndex(u => u.id === user.id)
        if (idx === -1) return
        const newOverrides: any = { ...list[idx].overrides }
        OV_GROUPS[ovTab].forEach(r => {
            newOverrides[r.key] = false
        })
        list[idx] = { ...list[idx], overrides: newOverrides }
        settings.store.watchlist = JSON.stringify(list)
        refresh()
        const label = getWatchedUser(settings, user.id)?.nick
        const u = UserStore.getUser(user.id)
        const name = displayName(u) || user.id
        Toasts.show({ type: Toasts.Type.DEFAULT, message: `${label ? `${label} (${name})` : name}: all ${OV_TAB_LABELS[ovTab]} disabled`, id: Toasts.genId() })
    }

    const applyPreset = (preset: "stalker" | "lite" | "silent") => {
        const label = getWatchedUser(settings, user.id)?.nick
        const u = UserStore.getUser(user.id)
        const name = displayName(u) || user.id
        const dn = label ? `${label} (${name})` : name
        Toasts.show({ type: Toasts.Type.SUCCESS, message: `${dn}: ${preset} preset applied`, id: Toasts.genId() })
        const list = getWatchlist(settings)
        const idx = list.findIndex(u => u.id === user.id)
        if (idx === -1) return
        const newOverrides: any = {}
        Object.keys(OV_GROUPS).forEach(g => {
            OV_GROUPS[g as OvTab].forEach(r => {
                newOverrides[r.key] = null
            })
        })
        if (preset === "silent") {
            Object.keys(OV_GROUPS).forEach(g => {
                OV_GROUPS[g as OvTab].forEach(r => {
                    newOverrides[r.key] = false
                })
            })
            list[idx] = { ...list[idx], overrides: newOverrides }
            settings.store.watchlist = JSON.stringify(list)
            refresh()
            return
        }
        if (preset === "lite") {
            newOverrides["msgs"] = true
            newOverrides["edits"] = true
            newOverrides["deletes"] = true
            newOverrides["typing"] = true
            newOverrides["avatar"] = true
            newOverrides["voice"] = true
            Object.keys(OV_GROUPS).forEach(g => {
                OV_GROUPS[g as OvTab].forEach(r => {
                    if (!["msgs","edits","deletes","typing","avatar","voice"].includes(r.key)) {
                        newOverrides[r.key] = false
                    }
                })
            })
            list[idx] = { ...list[idx], overrides: newOverrides }
            settings.store.watchlist = JSON.stringify(list)
            refresh()
            return
        }
        Object.keys(OV_GROUPS).forEach(g => {
            OV_GROUPS[g as OvTab].forEach(r => {
                newOverrides[r.key] = true
            })
        })
        list[idx] = { ...list[idx], overrides: newOverrides }
        settings.store.watchlist = JSON.stringify(list)
        refresh()
    }

    const detectPreset = (): "stalker" | "lite" | "silent" | "custom" => {
        const allKeys: string[] = []
        Object.keys(OV_GROUPS).forEach(g => {
            OV_GROUPS[g as OvTab].forEach(r => allKeys.push(r.key))
        })
        const ov = user.overrides as any
        const allFalse = allKeys.every(k => ov[k] === false)
        if (allFalse) return "silent"
        const allTrue = allKeys.every(k => ov[k] === true)
        if (allTrue) return "stalker"
        const liteKeys = ["msgs","edits","deletes","typing","avatar","voice"]
        const isLite = liteKeys.every(k => ov[k] === true) &&
            allKeys.filter(k => !liteKeys.includes(k)).every(k => ov[k] === false)
        if (isLite) return "lite"
        return "custom"
    }

    const activePreset = detectPreset()

    return (
        <div style={{ background: C.bg2, borderRadius: 20, marginBottom: 8, border: `1px solid ${C.border}`, overflow: "hidden" }}>
            <div className="ur-row-hover" onClick={() => setExp(!expanded)} style={{
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
                        {settings.store.globalPresetMode === "custom" && activePreset !== "custom" && (
                            <span style={{
                                background: activePreset === "stalker" ? `${C.danger}25` : activePreset === "lite" ? `${C.brandLight}25` : `${C.muted}25`,
                                color: activePreset === "stalker" ? C.danger : activePreset === "lite" ? C.brandLight : C.muted,
                                fontSize: 9,
                                fontWeight: 800,
                                padding: "2px 7px",
                                borderRadius: 6,
                                textTransform: "uppercase",
                                letterSpacing: 0.5,
                                border: `1px solid ${activePreset === "stalker" ? `${C.danger}60` : activePreset === "lite" ? `${C.brandLight}60` : `${C.muted}60`}`,
                            }}>
                                {activePreset}
                            </span>
                        )}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 3, display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontFamily: "monospace", opacity: .7 }}>{user.id}</span>
                        <span>·</span>
                        <span title={exactTime(user.addedAt)}>{timeAgo(user.addedAt)}</span>
                    </div>
                </div>

                <div onClick={(e: any) => e.stopPropagation()} style={{ width: 80, flexShrink: 0 }}>
                    <LabelInput nick={nick} setNick={setNick} saveNick={saveNick} />
                </div>

                <div
                    onClick={(e: any) => {
                        e.stopPropagation();
                        const u = UserStore.getUser(user.id);
                        const name = displayName(u) || user.id;
                        const av = u ? avatarUrl(u.id, (u as any).avatar, 64) : avatarUrl(user.id, null, 64);
                        openModal(p => (
                            <ModalRoot {...p} size={ModalSize.LARGE}>
                                <ModalHeader separator={false}>
                                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
                                        <img src={av} style={{ width: 36, height: 36, borderRadius: "50%" }} />
                                        <div>
                                            <div style={{ fontSize: 16, fontWeight: 700, color: C.header }}>{name}</div>
                                            <div style={{ fontSize: 12, color: C.muted }}>Activity Log</div>
                                        </div>
                                    </div>
                                    <ModalCloseButton onClick={p.onClose} />
                                </ModalHeader>
                                <ModalContent>
                                    <div style={{ padding: "0 12px" }}>
                                        <UserRadarActivityTab userId={user.id} />
                                    </div>
                                </ModalContent>
                                <ModalFooter>
                                    <ActivityLogFooter userId={user.id} />
                                </ModalFooter>
                            </ModalRoot>
                        ));
                    }}
                    title="Full Activity History"
                    style={{
                        padding: "5px 12px",
                        borderRadius: 12,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                        background: C.bg1,
                        color: C.text,
                        border: `1px solid ${C.border}`,
                        transition: "all 150ms cubic-bezier(0.4,0,0.2,1)",
                        userSelect: "none",
                        letterSpacing: 0.3,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        height: 28,
                        boxSizing: "border-box",
                    }}
                    onMouseEnter={e => {
                        e.currentTarget.style.background = C.hov;
                        e.currentTarget.style.borderColor = C.bgEl;
                    }}
                    onMouseLeave={e => {
                        e.currentTarget.style.background = C.bg1;
                        e.currentTarget.style.borderColor = C.border;
                    }}
                >
                    <span style={{ display: "flex", alignItems: "center", opacity: 0.9 }}>
                        <ico.history />
                    </span>
                    <span>Activity</span>
                    <ActivityBadge userId={user.id} />
                </div>
<div style={{ color: C.muted, display: "flex", alignItems: "center", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 200ms cubic-bezier(.4,0,.2,1)" }}>
                    <ico.chevron />
                </div>

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

            <div className={`ur-expand${expanded ? " open" : ""}`}>
                <div>
                    <div style={{ padding: "12px 16px 14px", borderTop: `1px solid ${C.border}`, background: C.bg2 }}>

                        <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center" }}>
                            <div style={{ display: "flex", gap: 4, background: C.bg3, padding: 3, borderRadius: 20, border: `1px solid ${C.border}`, position: "relative" }}>
                                {(["messages", "presence", "profile"] as OvTab[]).map(tab => (
                                    <div
                                        key={tab}
                                        onClick={() => { setOvTab(tab) }}
                                        style={{
                                            padding: "5px 14px",
                                            borderRadius: 16,
                                            fontSize: 12,
                                            fontWeight: 700,
                                            cursor: "pointer",
                                            background: ovTab === tab ? C.brand : "transparent",
                                            color: ovTab === tab ? C.white : C.muted,
                                            transition: "all 200ms cubic-bezier(0.4,0,0.2,1)",
                                            userSelect: "none",
                                            letterSpacing: 0.3,
                                            position: "relative",
                                            zIndex: 2,
                                            transform: ovTab === tab ? "scale(1.02)" : "scale(1)",
                                        }}
                                        onMouseEnter={e => {
                                            if (ovTab !== tab) {
                                                e.currentTarget.style.background = C.hov
                                                e.currentTarget.style.color = C.text
                                                e.currentTarget.style.transform = "scale(1.02)"
                                            }
                                        }}
                                        onMouseLeave={e => {
                                            if (ovTab !== tab) {
                                                e.currentTarget.style.background = "transparent"
                                                e.currentTarget.style.color = C.muted
                                                e.currentTarget.style.transform = "scale(1)"
                                            }
                                        }}
                                    >
                                        {OV_TAB_LABELS[tab]}
                                    </div>
                                ))}
                            </div>
                            <div style={{ flex: 1 }} />
                        </div>

                        <div style={{ marginTop: 0 }}>
                                <div style={{ background: "#313338", borderRadius: 12, border: `1px solid #3f4147`, padding: "16px", marginBottom: 12 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                                        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: "#b5bac1" }}>
                                            Quick Presets
                                        </div>
                                        <div style={{ fontSize: 11, color: "#949ba4" }}>
                                            one-click tracking profiles
                                        </div>
                                    </div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                        {([
                                            { key: "stalker" as const, label: "Stalker", desc: "Maximum tracking — every event", color: C.danger },
                                            { key: "lite" as const, label: "Lite", desc: "Messages, edits, deletes, typing, avatar, voice", color: C.brandLight },
                                            { key: "silent" as const, label: "Silent", desc: "Log everything silently — no pings", color: C.muted },
                                        ]).map(preset => {
                                            const isActive = activePreset === preset.key
                                            return (
                                                <div
                                                    key={preset.key}
                                                    onClick={() => applyPreset(preset.key)}
                                                    style={{
                                                        cursor: "pointer",
                                                        padding: "10px 14px",
                                                        borderRadius: 14,
                                                        transition: "all 150ms ease",
                                                        border: `1px solid ${isActive ? preset.color : `${preset.color}40`}`,
                                                        background: isActive ? `${preset.color}25` : `${preset.color}10`,
                                                        flex: 1,
                                                        minWidth: 120,
                                                    }}
                                                    onMouseEnter={e => {
                                                        if (!isActive) {
                                                            e.currentTarget.style.background = `${preset.color}20`
                                                            e.currentTarget.style.borderColor = `${preset.color}60`
                                                        }
                                                    }}
                                                    onMouseLeave={e => {
                                                        if (!isActive) {
                                                            e.currentTarget.style.background = `${preset.color}10`
                                                            e.currentTarget.style.borderColor = `${preset.color}40`
                                                        }
                                                    }}
                                                >
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                                                        {isActive && (
                                                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: preset.color, boxShadow: `0 0 6px ${preset.color}`, display: "inline-block", flexShrink: 0 }} />
                                                        )}
                                                        <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: isActive ? preset.color : C.text }}>
                                                            {preset.label}
                                                        </span>
                                                    </div>
                                                    <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.4 }}>
                                                        {preset.desc}
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
                                    <div
                                        onClick={enableAll}
                                        style={{
                                            fontSize: 11,
                                            fontWeight: 700,
                                            color: C.brandLight,
                                            cursor: "pointer",
                                            padding: "5px 12px",
                                            borderRadius: 20,
                                            border: `1px solid rgba(148,156,244,0.3)`,
                                            background: "rgba(148,156,244,0.08)",
                                            transition: "all 150ms ease",
                                            height: 26,
                                            boxSizing: "border-box",
                                            display: "flex",
                                            alignItems: "center",
                                            userSelect: "none",
                                        }}
                                        onMouseEnter={e => {
                                            e.currentTarget.style.background = "rgba(148,156,244,0.15)"
                                            e.currentTarget.style.borderColor = "rgba(148,156,244,0.5)"
                                        }}
                                        onMouseLeave={e => {
                                            e.currentTarget.style.background = "rgba(148,156,244,0.08)"
                                            e.currentTarget.style.borderColor = "rgba(148,156,244,0.3)"
                                        }}
                                    >Enable All</div>
                                    <div
                                        onClick={disableAll}
                                        style={{
                                            fontSize: 11,
                                            fontWeight: 700,
                                            color: C.muted,
                                            cursor: "pointer",
                                            padding: "5px 12px",
                                            borderRadius: 20,
                                            border: `1px solid rgba(148,163,184,0.2)`,
                                            background: "rgba(148,163,184,0.05)",
                                            transition: "all 150ms ease",
                                            height: 26,
                                            boxSizing: "border-box",
                                            display: "flex",
                                            alignItems: "center",
                                            userSelect: "none",
                                        }}
                                        onMouseEnter={e => {
                                            e.currentTarget.style.background = "rgba(148,163,184,0.1)"
                                            e.currentTarget.style.borderColor = "rgba(148,163,184,0.3)"
                                        }}
                                        onMouseLeave={e => {
                                            e.currentTarget.style.background = "rgba(148,163,184,0.05)"
                                            e.currentTarget.style.borderColor = "rgba(148,163,184,0.2)"
                                        }}
                                    >Disable All</div>
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                    {OV_GROUPS[ovTab].map(row => {
                                        const isOn = isFeatureOn(user.id, row.key as any, row.gk)
                                        const isOv = (user.overrides as any)[row.key] !== null && (user.overrides as any)[row.key] !== undefined
                                        return (
                                            <div key={row.key}
                                                onClick={() => setOv(row.key as any, !isOn)}
                                                style={{
                                                    background: "#313338",
                                                    borderRadius: 12,
                                                    border: `1px solid ${isOv ? "#5865f2" : "#3f4147"}`,
                                                    padding: "10px 12px",
                                                    cursor: "pointer",
                                                    transition: "border-color 150ms ease, background 150ms ease",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: 8,
                                                    height: 48,
                                                    boxSizing: "border-box",
                                                }}
                                                onMouseEnter={e => {
                                                    e.currentTarget.style.background = "#232428"
                                                    e.currentTarget.style.borderColor = isOv ? "#949cf4" : "#3f4147"
                                                }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.background = "#313338"
                                                    e.currentTarget.style.borderColor = isOv ? "#5865f2" : "#3f4147"
                                                }}
                                            >
                                                <div style={{ color: isOn ? C.brand : C.muted, display: "flex", alignItems: "center", flexShrink: 0, position: "relative" }}>
                                                    {isOn && (
                                                        <span className="ur-pulse" style={{
                                                            position: "absolute",
                                                            top: -2, right: -2,
                                                            width: 6, height: 6,
                                                            borderRadius: "50%",
                                                            background: C.brand,
                                                            zIndex: 2,
                                                        }} />
                                                    )}
                                                    {row.key === "typing" && isOn ? (
                                                        <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                                                            <span className="ur-typing-dot" style={{ width: 4, height: 4, borderRadius: "50%", background: C.brand, display: "inline-block" }} />
                                                            <span className="ur-typing-dot" style={{ width: 4, height: 4, borderRadius: "50%", background: C.brand, display: "inline-block" }} />
                                                            <span className="ur-typing-dot" style={{ width: 4, height: 4, borderRadius: "50%", background: C.brand, display: "inline-block" }} />
                                                        </div>
                                                    ) : <row.Icon />}
                                                </div>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ fontSize: 12, color: C.text, fontWeight: 600, userSelect: "none", lineHeight: 1.3 }}>
                                                        {row.label}
                                                        {isOv && (
                                                            <span style={{ color: C.brandLight, marginLeft: 4, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 }}>
                                                                custom
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div style={{ fontSize: 10, color: C.muted, userSelect: "none", marginTop: 1, lineHeight: 1.2 }}>
                                                        {row.desc}
                                                    </div>
                                                </div>
                                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                                    <div
                                                        role="button"
                                                        tabIndex={0}
                                                        title="preview notification"
                                                        onClick={(e: any) => { e.stopPropagation(); previewNotification(user.id, row.key) }}
                                                        onKeyDown={(e: any) => { if (e.key === "Enter") { e.stopPropagation(); previewNotification(user.id, row.key) } }}
                                                        style={{
                                                            color: C.muted,
                                                            cursor: "pointer",
                                                            width: 26,
                                                            height: 26,
                                                            borderRadius: 20,
                                                            display: "flex",
                                                            alignItems: "center",
                                                            justifyContent: "center",
                                                            transition: "all 150ms cubic-bezier(0.4,0,0.2,1)",
                                                            flexShrink: 0,
                                                            background: C.bg1,
                                                            border: `1px solid ${C.border}`,
                                                        }}
                                                        onMouseEnter={e => {
                                                            e.currentTarget.style.background = `${C.brand}18`
                                                            e.currentTarget.style.borderColor = `${C.brand}60`
                                                            e.currentTarget.style.color = C.brandLight
                                                            e.currentTarget.style.transform = "scale(1.08)"
                                                        }}
                                                        onMouseLeave={e => {
                                                            e.currentTarget.style.background = C.bg1
                                                            e.currentTarget.style.borderColor = C.border
                                                            e.currentTarget.style.color = C.muted
                                                            e.currentTarget.style.transform = "scale(1)"
                                                        }}
                                                    >
                                                        <ico.preview />
                                                    </div>
                                                    <Toggle on={isOn} onChange={v => setOv(row.key as any, v)} />
                                                    {isOv && (
                                                        <div role="button" tabIndex={0} title="reset to global"
                                                            onClick={(e: any) => { e.stopPropagation(); setOv(row.key as any, null) }}
                                                            onKeyDown={(e: any) => { if (e.key === "Enter") { e.stopPropagation(); setOv(row.key as any, null) } }}
                                                            style={{ color: C.muted, cursor: "pointer", fontSize: 10, padding: "2px 3px", borderRadius: 4, userSelect: "none" }}
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
                                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                                    <span
                                        onClick={resetAll}
                                        style={{
                                            fontSize: 11,
                                            color: C.muted,
                                            cursor: "pointer",
                                            fontWeight: 500,
                                            transition: "color 150ms ease",
                                        }}
                                        onMouseEnter={e => e.currentTarget.style.color = C.danger}
                                        onMouseLeave={e => e.currentTarget.style.color = C.muted}
                                    >
                                        Reset to Default ↩
                                    </span>
                                </div>
                            </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

type SortMode = "az" | "date"

function createToolbarButton() {
    const btn = document.createElement("div")
    btn.id = "ur-toolbar-btn"
    btn.setAttribute("role", "button")
    btn.setAttribute("tabindex", "0")
    btn.setAttribute("aria-label", "UserRadar Watchlist")
    btn.title = "UserRadar Watchlist"
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`
    btn.style.cssText = "display:flex;align-items:center;justify-content:center;width:32px;height:32px;cursor:pointer;color:#b5bac1;margin:0 2px;border-radius:4px;transition:color 150ms ease,background 150ms ease;"
    btn.onclick = () => openModal(p => <WatchlistModal modalProps={p} />)
    btn.onmouseenter = () => { btn.style.color = "#ffffff"; btn.style.background = "rgba(255,255,255,0.1)" }
    btn.onmouseleave = () => { btn.style.color = "#b5bac1"; btn.style.background = "transparent" }
    return btn
}

let __urToolbarTimer: ReturnType<typeof setInterval> | null = null
let __urDmTimer: ReturnType<typeof setInterval> | null = null

function injectToolbarButton() {
    if (document.getElementById("ur-toolbar-btn")) return true
    const toolbar = document.querySelector('[class^="toolbar"], [class*="toolbar_"]') as HTMLElement
    if (!toolbar) return false
    const btn = createToolbarButton()
    const firstChild = toolbar.firstElementChild
    if (firstChild) {
        toolbar.insertBefore(btn, firstChild)
    } else {
        toolbar.appendChild(btn)
    }
    return true
}

function startToolbarObserver() {
    let attempts = 0
    const tryInject = () => {
        if (injectToolbarButton() || attempts++ > 30) {
            if (__urToolbarTimer) {
                clearInterval(__urToolbarTimer)
                __urToolbarTimer = null
            }
        }
    }
    tryInject()
    __urToolbarTimer = setInterval(tryInject, 500)
    const observer = new MutationObserver(() => {
        if (!document.getElementById("ur-toolbar-btn")) injectToolbarButton()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    ;(window as any).__urToolbarObserver = observer
}

function stopToolbarObserver() {
    if (__urToolbarTimer) {
        clearInterval(__urToolbarTimer)
        __urToolbarTimer = null
    }
    const observer = (window as any).__urToolbarObserver
    if (observer) {
        observer.disconnect()
        delete (window as any).__urToolbarObserver
    }
    const btn = document.getElementById("ur-toolbar-btn")
    if (btn) btn.remove()
}

function GlobalPresetControl({ refresh }: { refresh: () => void }) {
    const mode = settings.store.globalPresetMode || "custom"
    const presets = [
        { key: "custom",  label: "Custom",  desc: "Per-user control",         color: C.brand },
        { key: "stalker", label: "Stalker", desc: "Everything tracked",       color: C.danger },
        { key: "lite",    label: "Lite",    desc: "Essential tracking only",  color: C.brandLight },
        { key: "silent",  label: "Silent",  desc: "Log everything silently",    color: "#b5bac1" }, // lighter gray for better active contrast
    ]
    const activeIndex = presets.findIndex(p => p.key === mode)

    return (
        <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: C.subheader, marginBottom: 10 }}>
                Global Preset Mode
            </div>

            <div style={{
                display: "grid",
                gridTemplateColumns: `repeat(${presets.length}, 1fr)`,
                background: C.bg1,
                borderRadius: 20,
                border: `1px solid ${C.border}`,
                padding: 4,
                position: "relative",
            }}>
                <div style={{
                    position: "absolute",
                    top: 4,
                    bottom: 4,
                    left: 4,
                    width: `calc((100% - 8px) / ${presets.length})`,
                    transform: `translateX(${activeIndex * 100}%)`,
                    background: presets[activeIndex].color + "20",
                    border: `1.5px solid ${presets[activeIndex].color}60`,
                    borderRadius: 16,
                    transition: "transform 300ms cubic-bezier(0.4, 0, 0.2, 1), background 200ms ease, border-color 200ms ease",
                    pointerEvents: "none",
                    boxSizing: "border-box",
                    zIndex: 1,
                }} />

                {presets.map(p => {
                    const isActive = mode === p.key
                    return (
                        <div
                            key={p.key}
                            onClick={() => { settings.store.globalPresetMode = p.key; refresh() }}
                            style={{
                                padding: "12px 6px",
                                borderRadius: 16,
                                cursor: "pointer",
                                textAlign: "center",
                                position: "relative",
                                zIndex: 2,
                                transition: "background 150ms ease",
                                userSelect: "none",
                            }}
                            onMouseEnter={e => {
                                if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.04)"
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.background = "transparent"
                            }}
                        >
                            <div style={{
                                fontSize: 13,
                                fontWeight: 700,
                                color: isActive ? p.color : C.muted,
                                marginBottom: 4,
                                transition: "color 200ms ease",
                                whiteSpace: "nowrap",
                            }}>
                                {p.label}
                            </div>
                            <div style={{
                                fontSize: 10,
                                color: isActive ? C.text : C.muted,
                                opacity: isActive ? 1 : 0.6,
                                lineHeight: 1.3,
                                transition: "color 200ms ease, opacity 200ms ease",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                padding: "0 2px",
                            }}>
                                {p.desc}
                            </div>
                        </div>
                    )
                })}
            </div>

            {mode !== "custom" && (
                <div style={{
                    marginTop: 10,
                    padding: "10px 14px",
                    background: C.bg1,
                    borderRadius: 14,
                    border: `1px solid ${C.border}`,
                    fontSize: 12,
                    color: C.muted,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                }}>
                    <span style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: presets[activeIndex].color,
                        flexShrink: 0,
                    }} />
                    <span>
                        All users follow the <b style={{ color: presets[activeIndex].color }}>{presets[activeIndex].label}</b> preset. Individual overrides are disabled. Switch to <b style={{ color: C.brand, cursor: "pointer" }} onClick={() => { settings.store.globalPresetMode = "custom"; refresh() }}>Custom</b> to configure per-user.
                    </span>
                </div>
            )}
        </div>
    )
}

function WatchlistModal({ modalProps }: { modalProps: any }) {
    React.useEffect(() => { injectStyles() }, [])

    const [users, setUsers]       = React.useState<WatchedUser[]>(() => { try { return getWatchlist(settings) } catch { return [] } })
    const [query, setQuery]       = React.useState("")
    const [sort,  setSort]        = React.useState<SortMode>("date")
    const [expandedId, setExpandedId] = React.useState<string | null>(null)

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
                        background: C.bg2,
                        border: `1px solid ${C.border}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
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

                    <GlobalPresetControl refresh={refresh} />

                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                        <div style={{ flex: 1, fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: C.subheader }}>
                            watchlist <span style={{ fontWeight: 500, color: C.muted }}>({users.length})</span>
                        </div>

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

                        <SearchInput query={query} setQuery={setQuery} />
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
                        <WatchedRow
                        key={u.id}
                        user={u}
                        refresh={refresh}
                        expandedId={expandedId}
                        setExpandedId={setExpandedId}
                        onRemove={() => { removeUser(settings, u.id); refresh() }}
                    />
                    ))}
                </div>
            </ModalContent>

            <ModalFooter>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            onClick={() => {
                                const input = document.createElement("input")
                                input.type = "file"
                                input.accept = ".json"
                                input.onchange = async (e: any) => {
                                    const file = e.target.files[0]
                                    if (!file) return
                                    try {
                                        const text = await file.text()
                                        const data = JSON.parse(text)
                                        if (!Array.isArray(data)) throw new Error("Invalid format")
                                        let added = 0
                                        for (const u of data) {
                                            if (u.id && !isWatched(settings, u.id)) {
                                                addUser(settings, u.id, u.nick || "")
                                                added++
                                            }
                                        }
                                        refresh()
                                        Toasts.show({
                                            message: `Imported ${added} users to watchlist`,
                                            id: Toasts.genId(),
                                            type: Toasts.Type.SUCCESS,
                                        })
                                    } catch (err: any) {
                                        Toasts.show({
                                            message: `Import failed: ${err.message || "Invalid file"}`,
                                            id: Toasts.genId(),
                                            type: Toasts.Type.FAILURE,
                                        })
                                    }
                                }
                                input.click()
                            }}
                            style={{
                                padding: "8px 16px",
                                borderRadius: 20,
                                background: C.bg1,
                                border: `1px solid ${C.border}`,
                                color: C.text,
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: "pointer",
                                fontFamily: "inherit",
                                transition: "all 150ms ease",
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = C.bgEl; e.currentTarget.style.background = C.bg2 }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.bg1 }}
                        >
                            <ico.download />
                            Import
                        </button>
                        <button
                            onClick={() => {
                                const list = getWatchlist(settings)
                                if (list.length === 0) {
                                    Toasts.show({
                                        message: "Watchlist is empty",
                                        id: Toasts.genId(),
                                        type: Toasts.Type.FAILURE,
                                    })
                                    return
                                }
                                const data = JSON.stringify(list, null, 2)
                                const blob = new Blob([data], { type: "application/json" })
                                const url = URL.createObjectURL(blob)
                                const a = document.createElement("a")
                                a.href = url
                                a.download = `userradar_watchlist_${new Date().toISOString().slice(0,10)}.json`
                                a.click()
                                URL.revokeObjectURL(url)
                                Toasts.show({
                                    message: `Exported ${list.length} users`,
                                    id: Toasts.genId(),
                                    type: Toasts.Type.SUCCESS,
                                })
                            }}
                            style={{
                                padding: "8px 16px",
                                borderRadius: 20,
                                background: C.bg1,
                                border: `1px solid ${C.border}`,
                                color: C.text,
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: "pointer",
                                fontFamily: "inherit",
                                transition: "all 150ms ease",
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = C.bgEl; e.currentTarget.style.background = C.bg2 }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.bg1 }}
                        >
                            <ico.upload />
                            Export
                        </button>
                        <button
                            onClick={() => {
                                if (confirm("Clear all activity logs for ALL watched users? This cannot be undone.")) {
                                    activityStore.clearAll().then(() => {
                                        Toasts.show({
                                            message: "All activity logs cleared",
                                            id: Toasts.genId(),
                                            type: Toasts.Type.SUCCESS,
                                        })
                                    })
                                }
                            }}
                            style={{
                                padding: "8px 16px",
                                borderRadius: 20,
                                background: "rgba(218,55,60,0.08)",
                                border: `1px solid ${C.red}`,
                                color: C.red,
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: "pointer",
                                fontFamily: "inherit",
                                transition: "all 150ms ease",
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = "rgba(218,55,60,0.15)" }}
                            onMouseLeave={e => { e.currentTarget.style.background = "rgba(218,55,60,0.08)" }}
                        >
                            <ico.clear />
                            Clear All Logs
                        </button>
                    </div>

                    <button
                        onClick={modalProps.onClose}
                        style={{
                            borderRadius: 20, height: 32, padding: "0 18px",
                            background: "transparent", color: C.text,
                            border: `1px solid ${C.border}`, fontSize: 13,
                            fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
                            transition: "background 150ms, border-color 150ms, color 150ms",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = C.brand; e.currentTarget.style.borderColor = C.brand; e.currentTarget.style.color = "#fff" }}
                        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.text }}
                    >
                        close
                    </button>
                </div>
            </ModalFooter>
        </ModalRoot>
    )
}

// context menu patches

const userCtxPatch: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user) return
    const isW = isWatched(settings, user.id)
    const idx = children.findIndex(c => c?.props?.id === "user-context-devmode-copy-id")
    children.splice(idx >= 0 ? idx + 1 : children.length, 0,
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="ur-watch"
                label={isW ? "Unwatch User" : "Watch User"}
                icon={isW ? CtxEyeOffIcon : CtxEyeIcon}
                action={() => {
                    if (isW) { removeUser(settings, user.id); Toasts.show({ type: Toasts.Type.DEFAULT, message: `removed ${displayName(user)} from watchlist`, id: Toasts.genId() }) }
                    else { addUser(settings, user.id); Toasts.show({ type: Toasts.Type.SUCCESS, message: `added ${displayName(user)} to watchlist`, id: Toasts.genId() }) }
                }}

            />
            <Menu.MenuItem
                id="ur-config"
                label="Manage Watchlist"
                icon={CtxGearIcon}
                action={() => openModal(p => <WatchlistModal modalProps={p} />)}

            />
        </Menu.MenuGroup>
    )
}

const msgCtxPatch: NavContextMenuPatchCallback = (children, { message }) => {
    if (!message?.author) return
    const isW = isWatched(settings, message.author.id)
    const idx = children.findIndex(c => c?.props?.id === "message-devmode-copy-id")
    children.splice(idx >= 0 ? idx + 1 : children.length, 0,
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="ur-msg-watch"
                label={isW ? "remove author from watchlist" : "add author to watchlist"}
                icon={isW ? CtxEyeOffIcon : CtxEyeIcon}
                action={() => {
                    if (isW) { removeUser(settings, message.author.id); Toasts.show({ type: Toasts.Type.DEFAULT, message: `removed ${displayName(message.author)} from watchlist`, id: Toasts.genId() }) }
                    else { addUser(settings, message.author.id); Toasts.show({ type: Toasts.Type.SUCCESS, message: `added ${displayName(message.author)} to watchlist`, id: Toasts.genId() }) }
                }}

            />
        </Menu.MenuGroup>
    )
}

// the plugin itself

// DM toolbar — injects clock icon for tracked users

const HISTORY_SVG = `<svg aria-hidden="true" role="img" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`

function injectDMActivityButton() {
    const match = location.pathname.match(/\/channels\/@me\/(\d+)/)
    if (!match) return
    const channelId = match[1]

    const channel = ChannelStore.getChannel(channelId)
    if (!channel || channel.type !== 1) return

    const recipientId = channel.recipients?.[0]
    if (!recipientId) return
    if (!isWatched(settings, recipientId)) return

    // Strategy: Find an existing toolbar button and use it as anchor.
    // Discord DM toolbar has buttons with aria-labels like "Start Voice Call",
    // "Start Video Call", "Add Friends to DM", etc.
    const knownButtonLabels = [
        'Start Voice Call',
        'Start Video Call',
        'Add Friends to DM',
        'Show Member List',
        'Threads',
        'Notification Settings',
        'Pinned Messages',
        'Search',
        'Inbox'
    ]

    let anchorBtn: Element | null = null
    for (const label of knownButtonLabels) {
        anchorBtn = document.querySelector(`[aria-label="${label}"]`)
        if (anchorBtn) break
    }

    // Also try finding by role=button in the header area
    if (!anchorBtn) {
        const header = document.querySelector('[class*="chat_"]') || document.querySelector('[class*="chatContent_"]')
        if (header) {
            const buttons = header.querySelectorAll('[role="button"]')
            for (const btn of buttons) {
                const rect = btn.getBoundingClientRect()
                // Must be visible and in the top area (toolbar)
                if (rect.width > 20 && rect.height > 20 && rect.top < 100) {
                    anchorBtn = btn
                    break
                }
            }
        }
    }

    if (!anchorBtn) return

    // Get the toolbar container (parent of the anchor button)
    const toolbar = anchorBtn.parentElement
    if (!toolbar) return

    // Don't inject if already present
    if (toolbar.querySelector('.ur-dm-activity-btn')) return

    // Create the icon button — matches Discord's native toolbar icons exactly
    const btn = document.createElement('div')
    btn.className = 'ur-dm-activity-btn'
    btn.setAttribute('role', 'button')
    btn.setAttribute('tabindex', '0')
    btn.setAttribute('aria-label', 'Track User History')
    btn.title = 'Track User History'
    btn.innerHTML = HISTORY_SVG
    btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:32px;height:32px;cursor:pointer;color:#b5bac1;border-radius:4px;transition:color 150ms ease,background 150ms ease;flex-shrink:0;'
    btn.onmouseenter = () => { btn.style.color = '#ffffff'; btn.style.background = 'rgba(255,255,255,0.1)' }
    btn.onmouseleave = () => { btn.style.color = '#b5bac1'; btn.style.background = 'transparent' }
    btn.onclick = (e) => {
        e.stopPropagation()
        e.preventDefault()
        const u = UserStore.getUser(recipientId)
        const name = displayName(u) || recipientId
        const av = u ? avatarUrl(u.id, (u as any).avatar, 64) : avatarUrl(recipientId, null, 64)
        openModal(p => (
            <ModalRoot {...p} size={ModalSize.LARGE}>
                <ModalHeader separator={false}>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
                        <img src={av} style={{ width: 36, height: 36, borderRadius: "50%" }} />
                        <div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: C.header }}>{name}</div>
                            <div style={{ fontSize: 12, color: C.muted }}>Activity Log</div>
                        </div>
                    </div>
                    <ModalCloseButton onClick={p.onClose} />
                </ModalHeader>
                <ModalContent>
                    <div style={{ padding: "0 12px" }}>
                        <UserRadarActivityTab userId={recipientId} />
                    </div>
                </ModalContent>
                <ModalFooter>
                    <ActivityLogFooter userId={recipientId} />
                </ModalFooter>
            </ModalRoot>
        ))
    }

    // prepend so it lands on the left
    toolbar.insertBefore(btn, toolbar.firstChild)
}

function startDMObserver() {
    injectDMActivityButton()
    __urDmTimer = setInterval(() => injectDMActivityButton(), 600)
    const observer = new MutationObserver(() => injectDMActivityButton())
    observer.observe(document.body, { childList: true, subtree: true })
    ;(window as any).__urDmObserver = observer
}

function stopDMObserver() {
    if (__urDmTimer) {
        clearInterval(__urDmTimer)
        __urDmTimer = null
    }
    const observer = (window as any).__urDmObserver
    if (observer) {
        observer.disconnect()
        delete (window as any).__urDmObserver
    }
    document.querySelectorAll('.ur-dm-activity-btn').forEach(el => el.remove())
}

export default definePlugin({
    name: "UserRadar",
    description: "track watched users and get notified on messages, edits, deletes, typing, profile/avatar changes, voice, status, activity, boosts, and server joins",
    authors: [{ name: "k1ng_op", id: 641266820187160576 }],
    settings,

    start() {
        addContextMenuPatch("user-context", userCtxPatch)
        addContextMenuPatch("message", msgCtxPatch)
        if (settings.store.showToolbarIcon) startToolbarObserver()
        startDMObserver()

        // load persistent activity log from disk so badges are correct on first render
        activityStore.load().catch(() => {})

        // pre-populate all caches BEFORE flux events start arriving
        // if we don't do this, the first VOICE_STATE_UPDATES looks like a join even if they were already in vc
        try {
            const vsMod    = findByProps("getVoiceStateForUser")
            const presMod  = findByProps("getStatus", "getActivities")
            const guildMod = findByProps("getGuildIds", "getGuild")
            const memMod   = findByProps("getMember", "isMember")
            const allGuilds: string[] = guildMod?.getGuildIds?.() ?? []

            for (const wu of getWatchlist(settings)) {
                try {
                    const vs = vsMod?.getVoiceStateForUser?.(wu.id)
                    vcCache[wu.id]     = vs?.channelId ?? null
                    cameraCache[wu.id] = vs?.selfVideo ?? false
                    streamCache[wu.id] = vs?.selfStream ?? false
                } catch { vcCache[wu.id] = null; cameraCache[wu.id] = false; streamCache[wu.id] = false }

                try {
                    const cs = presMod?.getClientStatus?.(wu.id)
                    if (cs) clientCache[wu.id] = resolveClient(cs as any)
                    else clientCache[wu.id] = null
                } catch { }

                // status + activity
                try {
                    const status = presMod?.getStatus?.(wu.id)
                    if (status) statusCache[wu.id] = status
                    const acts: any[] = presMod?.getActivities?.(wu.id) ?? []
                    const realAct = acts.find((a: any) => a.type !== 4) ?? null
                    activityCache[wu.id] = realAct ? `${realAct.type}:${realAct.name}` : null
                } catch { }

                // don't try to snapshot guild membership — isMember() returns wrong results
                // during discord's startup sequence while the member store is still loading
                // the 45s cooldown in GUILD_MEMBER_ADD handles this correctly instead
                guildCache[wu.id] = new Set()
            }
        } catch (e) { log.warn("snapshot failed", e) }

        // fetch baseline profiles in background — staggered so we don't get ratelimited
        // using setTimeout(fetchNext) instead of await-in-loop so start() returns fast
        const list = getWatchlist(settings)
        let i = 0
        const fetchNext = () => {
            if (i >= list.length) return
            const wu = list[i++]
            RestAPI.get({
                url: `/users/${wu.id}/profile`,
                query: { with_mutual_guilds: true, with_mutual_friends_count: false },
            }).then((res: any) => {
                const data = camelize(res.body)
                profileCache[wu.id] = data
                // populate guild cache from mutual_guilds — this is accurate data
                // no isMember() guesswork, straight from discord's api
                if (Array.isArray(data.mutualGuilds)) {
                    guildCache[wu.id] = new Set(data.mutualGuilds.map((g: any) => g.id))
                }
                setTimeout(fetchNext, 800)
            }).catch(() => setTimeout(fetchNext, 800))
        }
        setTimeout(fetchNext, 500)  // small delay so discord finishes its own startup first

        pollTimer = setInterval(pollProfiles, 5 * 60 * 1000)
        pluginStartedAt = Date.now()
    },

    stop() {
        removeContextMenuPatch("user-context", userCtxPatch)
        removeContextMenuPatch("message", msgCtxPatch)
        stopToolbarObserver()
        stopDMObserver()
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        Object.keys(profileCache).forEach(k => delete profileCache[k])
        Object.keys(vcCache).forEach(k => delete vcCache[k])
        Object.keys(statusCache).forEach(k => delete statusCache[k])
        Object.keys(activityCache).forEach(k => delete activityCache[k])
        Object.keys(guildCache).forEach(k => delete guildCache[k])
        Object.keys(vcJoinTime).forEach(k => delete vcJoinTime[k])
        Object.keys(clientCache).forEach(k => delete clientCache[k])
        Object.keys(cameraCache).forEach(k => delete cameraCache[k])
        Object.keys(streamCache).forEach(k => delete streamCache[k])
        pluginStartedAt = 0
        loggedMsgs = null
    },

    flux: {
        MESSAGE_CREATE({ optimistic, type, message, channelId }: MsgCreateEvent) {
            if (optimistic || type !== "MESSAGE_CREATE") return
            const uid = message.author?.id
            if (!uid || !isWatched(settings, uid)) return
            if (isFeatureOn(uid, "msgs", "globalMsgs")) {
                const label = getWatchedUser(settings, uid)?.nick
                const name  = displayName(message.author)
                const dn    = label ? `${label} (${name})` : name
                const ch    = ChannelStore.getChannel(channelId)
                const g     = ch?.guild_id ? findByProps("getGuild").getGuild(ch.guild_id) : null
                const chName  = ch?.name || "dm"
                const gName   = g?.name || ""
                // for DMs, ch.name is null — show recipient context instead
                const location = gName
                    ? `${gName} · #${chName}`
                    : ch?.recipients?.length
                        ? "Direct Message"
                        : `#${chName}`
                if (settings.store.skipCurrentChannel) {
                    const cur = getCurrentChannel()
                    if (cur?.id === channelId) return
                }
                notify({
                    title: `${dn} sent a message`,
                    body: msgPreview(message.content, message.attachments?.[0]?.filename),
                    icon: avatarUrl(uid, message.author?.avatar, 80),
                    onClick: () => jumpTo(ch?.guild_id, channelId, message.id),
                })
                logUserActivity(uid, "msg", "💬", `sent a message`, msgPreview(message.content, message.attachments?.[0]?.filename), {
                    guildId: ch?.guild_id,
                    channelId,
                    msgId: message.id,
                    metadata: {
                        server: g?.name || "Direct Message",
                        channel: chName,
                        content: message.content,
                    }
                }).catch(() => {})

            }
        },

        MESSAGE_UPDATE({ message }: MsgUpdateEvent) {
            const uid = message?.author?.id
            if (!uid || !isWatched(settings, uid)) return

            // edited_timestamp only exists on real user edits
            // embed resolution / pin events / reaction updates also fire MESSAGE_UPDATE but don't have this
            if (!message.edited_timestamp) return

            if (!isFeatureOn(uid, "edits", "globalEdits")) return

            const label = getWatchedUser(settings, uid)?.nick
            const name  = displayName(message.author)
            const dn    = label ? `${label} (${name})` : name
            const ch    = ChannelStore.getChannel(message.channel_id)
            const g     = ch?.guild_id ? findByProps("getGuild")?.getGuild(ch.guild_id) : null
            const chName = ch?.name || "dm"
            const gName  = g?.name || ""
            const location = gName ? `${gName} · #${chName}` : `DM · #${chName}`

            if (settings.store.skipCurrentChannel && getCurrentChannel()?.id === message.channel_id) return

            // try to get old content from cache for before → after preview
            // MessageStore still has the old version at the time MESSAGE_UPDATE fires
            const cached = MessageStore.getMessage(message.channel_id, message.id)
            const before = cached?.content && cached.content !== message.content
                ? `"${trunc(cached.content, 60)}" → `
                : ""
            const after = message.content
                ? `"${trunc(message.content, 60)}"`
                : "click to view"

            notify({
                title: `${dn} edited a message`,
                body: `${before}${after}`,
                icon: avatarUrl(uid, message.author?.avatar, 80),
                onClick: () => jumpTo(ch?.guild_id, message.channel_id, message.id),
            })
            logUserActivity(uid, "edit", "✏️", `edited a message in ${location}`, `${before}${after}`, {
                guildId: ch?.guild_id,
                channelId: message.channel_id,
                msgId: message.id,
                metadata: {
                    server: g?.name || "Direct Message",
                    channel: chName,
                }
            }).catch(() => {})

        },

        MESSAGE_DELETE({ id, channelId }: MsgDeleteEvent) {
            const store = tryLoadLoggedMsgs()
            // discord cache first, then try message logger in both key formats it uses
            const msg = MessageStore.getMessage(channelId, id)
                ?? store?.[id]
                ?? (store as any)?.[channelId]?.[id]
            if (!msg?.author) return
            const uid = msg.author.id
            if (!isWatched(settings, uid)) return
            if (isFeatureOn(uid, "deletes", "globalDeletes")) {
                const label = getWatchedUser(settings, uid)?.nick
                const name  = displayName(msg.author)
                const dn    = label ? `${label} (${name})` : name
                const ch    = ChannelStore.getChannel(channelId)
                const g     = ch?.guild_id ? findByProps("getGuild").getGuild(ch.guild_id) : null
                const chName  = ch?.name || "dm"
                const gName   = g?.name || ""
                // for DMs, ch.name is null — show recipient context instead
                const location = gName
                    ? `${gName} · #${chName}`
                    : ch?.recipients?.length
                        ? "Direct Message"
                        : `#${chName}`
                if (settings.store.skipCurrentChannel) {
                    const cur = getCurrentChannel()
                    if (cur?.id === channelId) return
                }
                notify({
                    title: `${dn} deleted a message`,
                    body: msgPreview(msg.content, msg.attachments?.[0]?.filename),
                    icon: avatarUrl(uid, msg.author?.avatar, 80),
                    onClick: () => jumpTo(ch?.guild_id, channelId, msg.id),
                })
                logUserActivity(uid, "delete", "🗑️", `deleted a message in ${location}`, msgPreview(msg.content, msg.attachments?.[0]?.filename), {
                    guildId: ch?.guild_id,
                    channelId,
                    msgId: msg.id,
                    metadata: {
                        server: g?.name || "Direct Message",
                        channel: chName,
                    }
                }).catch(() => {})
            }
        },

        TYPING_START({ channelId, userId }: TypingEvent) {
            if (!isWatched(settings, userId)) return
            if (isFeatureOn(userId, "typing", "globalTyping")) {
                const label = getWatchedUser(settings, userId)?.nick
                const u     = UserStore.getUser(userId)
                const name  = displayName(u) || userId
                const dn    = label ? `${label} (${name})` : name
                const ch    = ChannelStore.getChannel(channelId)
                const g     = ch?.guild_id ? findByProps("getGuild").getGuild(ch.guild_id) : null
                const chName  = ch?.name || "dm"
                const gName   = g?.name || ""
                // for DMs, ch.name is null — show recipient context instead
                const location = gName
                    ? `${gName} · #${chName}`
                    : ch?.recipients?.length
                        ? "Direct Message"
                        : `#${chName}`
                if (settings.store.skipCurrentChannel) {
                    const cur = getCurrentChannel()
                    if (cur?.id === channelId) return
                }
                // body format: "Server Name · #channel" or "Direct Message" for DMs
                notify({
                    title: `${dn} is typing…`,
                    body: location + "",
                    icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                    onClick: () => jumpTo(ch?.guild_id, channelId),
                })
                logUserActivity(userId, "typing", "💭", `is typing in ${location}`, `${gName ? gName + " · " : ""}#${chName}`, {
                    guildId: ch?.guild_id,
                    channelId,
                    metadata: {
                        server: gName || "Direct Message",
                        channel: chName,
                    }
                }).catch(() => {})
            }
        },

        async VOICE_STATE_UPDATES({ voiceStates }: VoiceStateEvent) {
            for (const vs of voiceStates || []) {
                const uid = vs.userId
                if (!isWatched(settings, uid)) continue
                const old = vcCache[uid]
                const now = vs.channelId || null
                const channelChanged = old !== now

                if (old === undefined) {
                    vcCache[uid] = now
                    cameraCache[uid] = vs.selfVideo ?? false
                    streamCache[uid] = vs.selfStream ?? false
                    continue
                }

                // update channel cache
                if (channelChanged) vcCache[uid] = now

                if (!isFeatureOn(uid, "voice", "globalVoice")) {
                cameraCache[uid] = vs.selfVideo ?? false
                    streamCache[uid] = vs.selfStream ?? false
                    continue
                }

                const label = getWatchedUser(settings, uid)?.nick
                const u     = UserStore.getUser(uid)
                const name  = displayName(u) || uid
                const dn    = label ? `${label} (${name})` : name
                const ch    = now ? ChannelStore.getChannel(now) : (old ? ChannelStore.getChannel(old) : null)
                const chName = ch?.name || "unknown"

                if (!channelChanged) {
                                    } else
                if (!old && now) {
                    vcJoinTime[uid] = Date.now()
                    const guildNameVc = ch?.guild_id ? findByProps("getGuild")?.getGuild(ch.guild_id)?.name : null
                    const sk = sessionKey(uid, "voice", now!)
                    notify({
                        title: `${dn} Joined Voice`,
                        body: (guildNameVc ? `${guildNameVc} · #${chName}` : `#${chName}`) + "",
                        icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                        onClick: () => jumpTo(ch?.guild_id, now!),
                    })
                    const vcMembers = (() => {
                        try {
                            const vsMod = findByProps("getVoiceStatesForChannel")
                            const raw = vsMod?.getVoiceStatesForChannel?.(now!)
                            if (!raw) return []
                            // handle both plain object and Map
                            const states: any[] = raw instanceof Map ? [...raw.values()] : Object.values(raw)
                            return states
                                .filter((s: any) => s?.userId && s.userId !== uid)
                                .map((s: any) => { const m = UserStore.getUser(s.userId); return m ? (m.globalName || m.username) : s.userId })
                        } catch { return [] }
                    })()
                    const joinPlatform = clientCache[uid] ? CLIENT_LABEL_MAP[clientCache[uid]!] || clientCache[uid] : undefined
                    const entry = await logUserActivity(uid, "voice", "🎙️", `joined #${chName}`, `${guildNameVc ? guildNameVc + " · " : ""}#${chName}${platformSuffixLog(uid)}`, {
                        guildId: ch?.guild_id,
                        channelId: now!,
                        metadata: {
                            server: guildNameVc || "DM",
                            channel: chName,
                            action: "joined",
                            platform: joinPlatform,
                            members: vcMembers.length > 0 ? vcMembers : undefined,
                        }
                    })
                    activeSessions[sk] = { logId: entry.id, startTime: Date.now(), channelId: now!, guildId: ch?.guild_id, metadata: { server: guildNameVc || "DM", channel: chName, platform: joinPlatform || clientCache[uid] ? (CLIENT_LABEL_MAP[clientCache[uid]!] || clientCache[uid]) : undefined, members: vcMembers.length > 0 ? vcMembers : undefined } }
                } else if (old && !now) {
                    const spent = vcJoinTime[uid] ? Date.now() - vcJoinTime[uid] : 0
                    delete vcJoinTime[uid]
                    const dur = spent > 60000 ? formatDuration(spent) : ""
                    const guildNameVcLeft = (ch ?? (old ? ChannelStore.getChannel(old) : null))
                    const guildNameVcLeftStr = guildNameVcLeft?.guild_id ? findByProps("getGuild")?.getGuild(guildNameVcLeft.guild_id)?.name : null
                    const sk = sessionKey(uid, "voice", old!)
                    const session = activeSessions[sk]

                    if (session) {
                        // Update the original join log with session info
                        await activityStore.updateLog(uid, session.logId, {
                            type: "session",
                            title: dur ? `In #${chName} · ${dur}` : `In #${chName}`,
                            body: `${guildNameVcLeftStr || "DM"} · #${chName}`,
                            metadata: {
                                ...session.metadata,
                                action: "voice_session",
                                startTime: session.startTime,
                                endTime: Date.now(),
                                duration: dur || "< 1m",
                                platform: session.metadata?.platform || (clientCache[uid] ? (CLIENT_LABEL_MAP[clientCache[uid]!] || clientCache[uid]) : undefined),
                                appName: session.metadata?.appName || guildNameVcLeftStr || "Discord",
                            }
                        })
                        delete activeSessions[sk]
                        notify({
                            title: `${dn} Left Voice`,
                            body: guildNameVcLeftStr ? `${guildNameVcLeftStr} · #${chName}${dur ? " · " + dur : ""}` : `#${chName}${dur ? " · " + dur : ""}`,
                            icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                            onClick: () => openUserProfile(uid),
                        })
                    } else {
                        // No session found, log as separate leave event
                        notify({
                            title: `${dn} Left Voice`,
                            body: guildNameVcLeftStr ? `${guildNameVcLeftStr} · #${chName}` : `#${chName}`,
                            icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                            onClick: () => openUserProfile(uid),
                        })
                        logUserActivity(uid, "voice", "🎙️", `left #${chName}`, `${guildNameVcLeftStr ? guildNameVcLeftStr + " · " : ""}#${chName}`, {
                            guildId: ch?.guild_id || guildNameVcLeft?.guild_id,
                            channelId: old!,
                            metadata: {
                                server: guildNameVcLeftStr || "DM",
                                channel: chName,
                                action: "left",
                            }
                        }).catch(() => {})
                    }
                } else if (old && now && old !== now) {
                    const oldCh = ChannelStore.getChannel(old)
                    const guildNameVcMove = ch?.guild_id ? findByProps("getGuild")?.getGuild(ch.guild_id)?.name : null
                    notify({
                        title: `${dn} Moved Voice Channels`,
                        body: guildNameVcMove
                            ? `${guildNameVcMove}: #${oldCh?.name || "?"} → #${chName}`
                            : `#${oldCh?.name || "?"} → #${chName}`,
                        icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                        onClick: () => jumpTo(ch?.guild_id, now!),
                    })
                    logUserActivity(uid, "voice", "🎙️", `moved voice channels`, `${guildNameVcMove ? guildNameVcMove + " · " : ""}#${oldCh?.name || "?"} → #${chName}`, {
                        guildId: ch?.guild_id,
                        channelId: now!,
                        metadata: {
                            server: guildNameVcMove || "DM",
                            fromChannel: oldCh?.name || "?",
                            toChannel: chName,
                            action: "moved",
                        }
                    }).catch(() => {})
                }

                // runs on every VOICE_STATE_UPDATES regardless of channel change
                // discord sends a separate event when selfVideo/selfStream flips
                const currentCh = now ? ChannelStore.getChannel(now) : ch
                const currentChName = currentCh?.name || chName || "unknown"
                const currentChId = now || (old ?? undefined)
                const currentGuildId = currentCh?.guild_id

                if (now) {
                    // camera
                    const newCamera = vs.selfVideo ?? false
                    const oldCamera = cameraCache[uid] ?? false
                    if (oldCamera !== newCamera) {
                        cameraCache[uid] = newCamera
                        const camSk = sessionKey(uid, "camera", currentChId)
                        if (newCamera) {
                            // Camera turned on - start session
                            notify({
                                title: `${dn} turned on camera`,
                                body: `in #${currentChName}`,
                                icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                                onClick: () => jumpTo(currentGuildId, currentChId),
                            })
                            const camPlatform = clientCache[uid] ? CLIENT_LABEL_MAP[clientCache[uid]!] || clientCache[uid] : undefined
                            logUserActivity(uid, "voice", "📷", `camera on in #${currentChName}`, `#${currentChName}`, {
                                guildId: currentGuildId,
                                channelId: currentChId,
                                metadata: {
                                    server: currentGuildId ? findByProps("getGuild")?.getGuild(currentGuildId)?.name : "DM",
                                    channel: currentChName,
                                    action: "camera_on",
                                    platform: camPlatform,
                                }
                            }).then(camEntry => {
                                activeSessions[camSk] = { logId: camEntry.id, startTime: Date.now(), channelId: currentChId, guildId: currentGuildId, metadata: { server: currentGuildId ? findByProps("getGuild")?.getGuild(currentGuildId)?.name : "DM", channel: currentChName, platform: camPlatform } }
                            }).catch(() => {})
                        } else {
                                            const camSession = activeSessions[camSk]
                            const camSpent = camSession ? Date.now() - camSession.startTime : 0
                            const camDur = camSpent > 60000 ? formatDuration(camSpent) : ""
                            if (camSession) {
                                activityStore.updateLog(uid, camSession.logId, {
                                    type: "session",
                                    title: camDur ? `Camera on · ${camDur}` : `Camera on`,
                                    body: `${camSession.metadata?.server || "DM"} · #${camSession.metadata?.channel || currentChName}`,
                                    metadata: {
                                        ...camSession.metadata,
                                        action: "camera_session",
                                        startTime: camSession.startTime,
                                        endTime: Date.now(),
                                        duration: camDur || "< 1m",
                                    }
                                }).then(() => { delete activeSessions[camSk] }).catch(() => { delete activeSessions[camSk] })
                            }
                            notify({
                                title: `${dn} turned off camera`,
                                body: `in #${currentChName}${camDur ? " · " + camDur : ""}`,
                                icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                                onClick: () => jumpTo(currentGuildId, currentChId),
                            })
                        }
                    }

                    const newStream = vs.selfStream ?? false
                    const oldStream = streamCache[uid] ?? false
                    if (oldStream !== newStream) {
                        streamCache[uid] = newStream
                        const streamSk = sessionKey(uid, "stream", currentChId)
                        if (newStream) {
                                notify({
                                title: `${dn} started screen sharing`,
                                body: `in #${currentChName}`,
                                icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                                onClick: () => jumpTo(currentGuildId, currentChId),
                            })
                            const streamPlatform = clientCache[uid] ? CLIENT_LABEL_MAP[clientCache[uid]!] || clientCache[uid] : undefined
                            logUserActivity(uid, "voice", "🖥️", `screen sharing in #${currentChName}`, `#${currentChName}`, {
                                guildId: currentGuildId,
                                channelId: currentChId,
                                metadata: {
                                    server: currentGuildId ? findByProps("getGuild")?.getGuild(currentGuildId)?.name : "DM",
                                    channel: currentChName,
                                    action: "stream_on",
                                    platform: streamPlatform,
                                }
                            }).then(streamEntry => {
                                activeSessions[streamSk] = { logId: streamEntry.id, startTime: Date.now(), channelId: currentChId, guildId: currentGuildId, metadata: { server: currentGuildId ? findByProps("getGuild")?.getGuild(currentGuildId)?.name : "DM", channel: currentChName, platform: streamPlatform } }
                            }).catch(() => {})
                        } else {
                                const streamSession = activeSessions[streamSk]
                            const streamSpent = streamSession ? Date.now() - streamSession.startTime : 0
                            const streamDur = streamSpent > 60000 ? formatDuration(streamSpent) : ""
                            if (streamSession) {
                                activityStore.updateLog(uid, streamSession.logId, {
                                    type: "session",
                                    title: streamDur ? `Screen sharing · ${streamDur}` : `Screen sharing`,
                                    body: `${streamSession.metadata?.server || "DM"} · #${streamSession.metadata?.channel || currentChName}`,
                                    metadata: {
                                        ...streamSession.metadata,
                                        action: "stream_session",
                                        startTime: streamSession.startTime,
                                        endTime: Date.now(),
                                        duration: streamDur || "< 1m",
                                    }
                                }).then(() => { delete activeSessions[streamSk] }).catch(() => { delete activeSessions[streamSk] })
                            }
                            notify({
                                title: `${dn} stopped screen sharing`,
                                body: `in #${currentChName}${streamDur ? " · " + streamDur : ""}`,
                                icon: u ? avatarUrl(u.id, (u as any).avatar, 80) : undefined,
                                onClick: () => jumpTo(currentGuildId, currentChId),
                            })
                        }
                    }
                } else {
                    cameraCache[uid] = false
                    streamCache[uid] = false
                }
            }
        },

        async PRESENCE_UPDATES({ updates }: PresenceEvent) {
                            const isStartup = Date.now() - pluginStartedAt < 15000
            for (const u of updates || []) {
                const uid = u.user?.id
                if (!uid || !isWatched(settings, uid)) continue

                const oldStatus = statusCache[uid]
                const newStatus = u.status

                const STATUS_LABEL: Record<string, string> = { online: "Online", idle: "Away", dnd: "Do Not Disturb", offline: "Offline", invisible: "Invisible" }

                const isOfflineStatus = (s: string) => s === "offline" || s === "invisible"
                const wasOffline = isOfflineStatus(oldStatus)
                const isOffline = isOfflineStatus(newStatus)
                let sessionJustEnded = false

                if (!isOffline && !isStartup) {
                    if (!statusSessionCache[uid]) {
                        statusSessionCache[uid] = {
                            startTime: Date.now(),
                            startStatus: newStatus,
                            changes: [{ status: newStatus, ts: Date.now() }],
                            platforms: clientCache[uid] ? [{ platform: clientCache[uid]!, ts: Date.now() }] : [],
                        }
                    }
                }

                if (!isOffline && statusSessionCache[uid] && oldStatus !== newStatus && !isStartup) {
                    statusSessionCache[uid]!.changes.push({ status: newStatus, ts: Date.now() })
                    const label = getWatchedUser(settings, uid)?.nick
                    const userObj  = UserStore.getUser(uid)
                    const name  = displayName(userObj) || uid
                    const dn    = label ? `${label} (${name})` : name
                    notify({
                        title: `${dn} is now ${newStatus}`,
                        body: `was: ${STATUS_LABEL[oldStatus] || oldStatus}`,
                        icon: userObj ? avatarUrl(userObj.id, (userObj as any).avatar, 80) : undefined,
                        onClick: () => openUserProfile(uid),
                    })
                }

                if (isOffline && statusSessionCache[uid] && !isStartup) {
                    const session = statusSessionCache[uid]!
                    const duration = Date.now() - session.startTime
                    const durStr = formatDuration(duration)
                    const changes = session.changes
                    const label = getWatchedUser(settings, uid)?.nick
                    const user  = UserStore.getUser(uid)
                    const name  = displayName(user) || uid
                    const dn    = label ? `${label} (${name})` : name
                    const sessionPlatform = clientCache[uid] ? (CLIENT_LABEL_MAP[clientCache[uid]!] || clientCache[uid]) : undefined

                    const statusTimeline = changes.map((ch, i) => {
                        const prev = i > 0 ? changes[i - 1].status : session.startStatus
                        if (ch.status === prev && i > 0) return null
                        return {
                            status: ch.status,
                            emoji: STATUS_EMOJI_LOCAL[ch.status] || "⚫",
                            label: STATUS_LABEL[ch.status] || ch.status,
                            time: new Date(ch.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }),
                            ts: ch.ts,
                        }
                    }).filter(Boolean)

                    const platformTimeline = (session.platforms || []).map((pt: any, i: number) => {
                        const prev = i > 0 ? session.platforms[i - 1].platform : null
                        if (pt.platform === prev && i > 0) return null
                        return {
                            platform: pt.platform,
                            time: new Date(pt.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }),
                            ts: pt.ts,
                        }
                    }).filter(Boolean)

                    notify({
                        title: `${dn} went offline`,
                        body: durStr ? `Online for ${durStr}` : "",
                        icon: user ? avatarUrl(user.id, (user as any).avatar, 80) : undefined,
                        onClick: () => openUserProfile(uid),
                    })

                    logUserActivity(uid, "session", "⏱️", durStr ? `Online session · ${durStr}` : "Online session", "", {
                        metadata: {
                            action: "status_session",
                            startTime: session.startTime,
                            endTime: Date.now(),
                            duration: durStr || "< 1m",
                            startStatus: session.startStatus,
                            endStatus: newStatus,
                            statusTimeline,
                            platformTimeline,
                            changeCount: changes.length,
                            platform: sessionPlatform,
                        }
                    }).catch(() => {})

                    statusSessionCache[uid] = null
                    sessionJustEnded = true
                }

                if (oldStatus !== undefined && oldStatus !== newStatus && isFeatureOn(uid, "status", "globalStatus") && !isStartup && !statusSessionCache[uid] && !sessionJustEnded) {
                    const label = getWatchedUser(settings, uid)?.nick
                    const user  = UserStore.getUser(uid)
                    const name  = displayName(user) || uid
                    const dn    = label ? `${label} (${name})` : name
                    const platLog = platformSuffixLog(uid)
                    notify({
                        title: `${dn} is now ${newStatus}`,
                        body: `was: ${STATUS_LABEL[oldStatus] || oldStatus}`,
                        icon: user ? avatarUrl(user.id, (user as any).avatar, 80) : undefined,
                        onClick: () => openUserProfile(uid),
                    })
                    logActivity(uid, "status", STATUS_EMOJI_LOCAL[newStatus] || "⚫", `${STATUS_LABEL[oldStatus] || oldStatus} → ${STATUS_LABEL[newStatus] || newStatus}${platLog}`)
                }
                statusCache[uid] = newStatus

                const newClient = resolveClient((u as any).client_status ?? (u as any).clientStatus)
                const oldClient = clientCache[uid]
                const comingOnline = oldStatus === "offline" && newStatus !== "offline"
                if (oldClient !== undefined && newClient !== null && oldClient !== newClient && !isStartup && !comingOnline) {
                    clientCache[uid] = newClient
                    if (statusSessionCache[uid]) {
                        statusSessionCache[uid]!.platforms.push({ platform: newClient, ts: Date.now() })
                    }
                    if (!statusSessionCache[uid] && isFeatureOn(uid, "status", "globalStatus")) {
                        const label = getWatchedUser(settings, uid)?.nick
                        const user  = UserStore.getUser(uid)
                        const name  = displayName(user) || uid
                        const dn    = label ? `${label} (${name})` : name
                        const emoji = CLIENT_EMOJI[newClient] || "📡"
                        const oldEmoji = oldClient ? (CLIENT_EMOJI[oldClient] || "📡") : ""
                        const CLIENT_LABEL: Record<string, string> = { desktop: "Desktop", mobile: "Mobile", web: "Web" }
                        logActivity(uid, "status", emoji, `${oldClient ? `${oldEmoji} ${oldClient} → ` : ""}${emoji} ${newClient}`)
                    }
                } else if (newClient !== null) {
                    clientCache[uid] = newClient
                }

                const realAct = (u.activities || []).find((a: any) => a.type !== 4) ?? null
                const newActKey = realAct
                    ? realAct.type === 2
                        ? `2:${realAct.name}:${realAct.details || ""}:${realAct.state || ""}`
                        : `${realAct.type}:${realAct.name}`
                    : null
                const oldAct = activityCache[uid]

                if (oldAct !== undefined && oldAct !== newActKey && isFeatureOn(uid, "activity", "globalActivity") && !isStartup) {
                    const ACT_VERB: Record<number, string> = { 0: "playing", 2: "listening to", 3: "watching", 5: "competing in" }
                    const actPlatform = clientCache[uid] ? (CLIENT_LABEL_MAP[clientCache[uid]!] || clientCache[uid]) : undefined
                    const label = getWatchedUser(settings, uid)?.nick
                    const user  = UserStore.getUser(uid)
                    const name  = displayName(user) || uid
                    const dn    = label ? `${label} (${name})` : name

                    const [oldTypeStr, ...oldNameParts] = (oldAct || "").split(":")
                    const oldType = oldAct ? parseInt(oldTypeStr) : -1
                    const isOldListening = oldType === 2
                    const oldSongName = isOldListening && oldNameParts.length >= 2 ? oldNameParts[1] : oldNameParts.join(":")
                    const oldArtistName = isOldListening && oldNameParts.length >= 3 ? oldNameParts[2].replace(/;.*/, "").trim() : ""

                    if (realAct && !oldAct) {
                        if (realAct.type !== 2) {
                            const verb = ACT_VERB[realAct.type] ?? "playing"
                            const icon = realAct.type === 1 ? "📺" : realAct.type === 3 ? "🎬" : realAct.type === 5 ? "🏆" : "🎮"
                            const actSk = sessionKey(uid, "activity", newActKey || undefined)
                            let activityDesc = realAct.name || ""
                            let logBody = `${verb} ${realAct.name}`

                            if (realAct.type === 1 && realAct.details) {
                                activityDesc = `${realAct.name}: ${realAct.details}`
                                logBody = `streaming ${realAct.details}`
                            } else if ((realAct.type === 0 || realAct.type === 3 || realAct.type === 5) && realAct.details) {
                                activityDesc = `${realAct.name} — ${realAct.details}`
                                logBody = `${realAct.name}: ${realAct.details}`
                                if (realAct.state) logBody += ` · ${realAct.state}`
                            }

                            const actTitle = realAct.details
                                ? `${verb} ${realAct.name} — ${realAct.details}`
                                : `${verb} ${realAct.name}`

                            notify({
                                title: `${dn} is ${verb} ${realAct.name}`,
                                body: activityDesc,
                                icon: user ? avatarUrl(user.id, (user as any).avatar, 80) : undefined,
                                onClick: () => openUserProfile(uid),
                            })
                            const gameLargeImg = realAct.assets?.large_image || ""
                            const gameAppId = realAct.application_id || ""
                            let gameIconUrl = ""
                            if (gameLargeImg) {
                                if (gameLargeImg.startsWith("mp:external/")) {
                                    gameIconUrl = `https://media.discordapp.net/external/${gameLargeImg.slice(12)}`
                                } else if (gameLargeImg.startsWith("mp:app-asset/")) {
                                    gameIconUrl = `https://media.discordapp.net/app-assets/${gameLargeImg.slice(13)}`
                                } else if (gameLargeImg.startsWith("mp:")) {
                                    gameIconUrl = `https://media.discordapp.net/${gameLargeImg.slice(3)}`
                                } else if (gameLargeImg.startsWith("spotify:")) {
                                    gameIconUrl = `https://i.scdn.co/image/${gameLargeImg.slice(8)}`
                                } else if (gameAppId && !gameLargeImg.includes(":")) {
                                    gameIconUrl = `https://cdn.discordapp.com/app-assets/${gameAppId}/${gameLargeImg}.png`
                                } else {
                                    gameIconUrl = gameLargeImg
                                }
                            }

                            const entry = await logUserActivity(uid, "activity", icon, actTitle, logBody, {
                                metadata: {
                                    name: realAct.name,
                                    appName: realAct.name,
                                    details: realAct.details,
                                    state: realAct.state,
                                    type: realAct.type,
                                    platform: actPlatform,

                                    action: "activity_start",
                                    applicationId: realAct.application_id || "",
                                    sessionId: realAct.session_id || "",
                                    timestamps: realAct.timestamps || {},
                                    party: realAct.party || {},
                                    assets: realAct.assets || {},
                                    largeImage: gameLargeImg,
                                    gameIconUrl,
                                    flags: realAct.flags || 0,
                                    url: realAct.url || "",
                                }
                            })
                            activeSessions[actSk] = {
                                logId: entry.id,
                                startTime: Date.now(),
                                metadata: {
                                    name: realAct.name,
                                    appName: realAct.name,
                                    details: realAct.details,
                                    state: realAct.state,
                                    platform: actPlatform,
                                    gameIconUrl,
                                }
                            }
                        }
                    }

                    else if (!realAct && oldAct) {
                        const verb = ACT_VERB[oldType] ?? "playing"

                        if (isOldListening) {
                            const listenSk = sessionKey(uid, "listening", `${oldSongName}:${oldArtistName}`)
                            const session = activeSessions[listenSk]
                            if (session) {
                                const elapsed = Date.now() - session.startTime
                                const dur = elapsed > 60000 ? formatDuration(elapsed) : ""
                                await activityStore.updateLog(uid, session.logId, {
                                    type: "session",
                                    title: dur ? `${oldSongName} · ${dur}` : oldSongName,
                                    body: `${oldSongName} by ${oldArtistName}`,
                                    metadata: {
                                        ...session.metadata,
                                        action: "listening_session",
                                        endTime: Date.now(),
                                        duration: dur || "< 1m",
                                    }
                                })
                                delete activeSessions[listenSk]
                            }
                        } else {
                            const actSk = sessionKey(uid, "activity", oldAct || undefined)
                            const session = activeSessions[actSk]
                            if (session) {
                                const elapsed = Date.now() - session.startTime
                                const dur = elapsed > 60000 ? formatDuration(elapsed) : ""
                                await activityStore.updateLog(uid, session.logId, {
                                    type: "session",
                                    title: dur ? `${oldSongName} · ${dur}` : oldSongName,
                                    body: `${verb} ${oldSongName}`,
                                    metadata: {
                                        ...session.metadata,
                                        action: "activity_session",
                                        startTime: session.startTime,
                                        endTime: Date.now(),
                                        duration: dur || "< 1m",
                                        name: oldSongName,
                                        type: oldType,
                                    }
                                })
                                delete activeSessions[actSk]
                                notify({
                                    title: `${dn} stopped ${verb} ${oldSongName}`,
                                    body: dur ? `Session lasted ${dur}` : "",
                                    icon: user ? avatarUrl(user.id, (user as any).avatar, 80) : undefined,
                                    onClick: () => openUserProfile(uid),
                                })
                            } else {
                                notify({
                                    title: `${dn} stopped ${verb} ${oldSongName}`,
                                    body: "",
                                    icon: user ? avatarUrl(user.id, (user as any).avatar, 80) : undefined,
                                    onClick: () => openUserProfile(uid),
                                })
                            }
                        }
                    }
                    else if (realAct && oldAct) {
                        if (realAct.type === 2) {
                            const smallImg = realAct.assets?.small_image || ""
                            const smallTxt = realAct.assets?.small_text || realAct.assets?.smallText || ""
                            const statusDisp = realAct.status_display_type ?? null
                            const createdAt = realAct.created_at || null
                            const sessionId = realAct.session_id || ""
                            const flags    = realAct.flags || 0
                            const buttons  = realAct.buttons || []
                            const secrets  = realAct.secrets || {}
                            const url      = realAct.url || ""
                            const platform = realAct.platform || actPlatform || ""

                            let albumArtUrl = ""
                            if (largeImg) {
                                if (largeImg.startsWith("spotify:")) {
                                    albumArtUrl = `https://i.scdn.co/image/${largeImg.replace("spotify:", "")}`
                                } else if (largeImg.startsWith("mp:")) {
                                    albumArtUrl = `https://media.discordapp.net/${largeImg.replace("mp:", "")}`
                                }
                            }

                            const displayTitle = song && artist
                                ? `${song} — ${artist}`
                                : song || realAct.name || "Unknown Track"
                            const displayBody = song && artist
                                ? `${song} by ${artist}${album ? ` · ${album}` : ""}`
                                : song || realAct.name || ""

                            const oldListenSk = sessionKey(uid, "listening", `${oldSongName}:${oldArtistName}`)
                            const oldSession = activeSessions[oldListenSk]
                            if (oldSession) {
                                const elapsed = Date.now() - oldSession.startTime
                                const dur = elapsed > 60000 ? formatDuration(elapsed) : ""
                                await activityStore.updateLog(uid, oldSession.logId, {
                                    type: "session",
                                    title: dur ? `${oldSongName} · ${dur}` : oldSongName,
                                    body: `${oldSongName} by ${oldArtistName}`,
                                    metadata: {
                                        ...oldSession.metadata,
                                        action: "listening_session",
                                        endTime: Date.now(),
                                        duration: dur || "< 1m",
                                    }
                                })
                                delete activeSessions[oldListenSk]
                            }

                            notify({
                                title: `${dn} is listening to ${song || realAct.name}`,
                                body: displayBody,
                                icon: user ? avatarUrl(user.id, (user as any).avatar, 80) : undefined,
                                onClick: () => openUserProfile(uid),
                            })

                            const entry = await logUserActivity(uid, "activity", "🎵", displayTitle, displayBody, {
                                metadata: {
                                    name: realAct.name,
                                    appName: realAct.name,
                                    song,
                                    artist,
                                    allArtists,
                                    album,
                                    trackId,
                                    albumId,
                                    artistIds,
                                    contextUri,
                                    trackType,
                                    albumArtUrl,
                                    largeImage: largeImg,
                                    smallImage: smallImg,
                                    smallText: smallTxt,
                                    startTimestamp: startTs,
                                    endTimestamp: endTs,
                                    createdAt,
                                    sessionId,
                                    partyId,
                                    partySize,
                                    applicationId: appId,
                                    parentApplicationId: parentAppId,
                                    platform,
                                    statusDisplayType: statusDisp,
                                    flags,
                                    buttons,
                                    secrets,
                                    url,
                                    type: realAct.type,
                                    action: "listening_change",
                                }
                            })

                            const listenSk = sessionKey(uid, "listening", trackId || `${song}:${artist}`)
                            activeSessions[listenSk] = {
                                logId: entry.id,
                                startTime: Date.now(),
                                metadata: {
                                    name: realAct.name,
                                    appName: realAct.name,
                                    song,
                                    artist,
                                    allArtists,
                                    album,
                                    trackId,
                                    albumId,
                                    artistIds,
                                    contextUri,
                                    trackType,
                                    albumArtUrl,
                                    largeImage: largeImg,
                                    smallImage: smallImg,
                                    smallText: smallTxt,
                                    startTimestamp: startTs,
                                    endTimestamp: endTs,
                                    createdAt,
                                    sessionId,
                                    partyId,
                                    partySize,
                                    applicationId: appId,
                                    parentApplicationId: parentAppId,
                                    platform,
                                    statusDisplayType: statusDisp,
                                    flags,
                                    buttons,
                                    secrets,
                                    url,
                                    type: realAct.type,
                                }
                            }
                        }
                        else {
                            const verb = ACT_VERB[realAct.type] ?? "playing"
                            const icon = realAct.type === 1 ? "📺" : realAct.type === 3 ? "🎬" : realAct.type === 5 ? "🏆" : "🎮"
                            const actSk = sessionKey(uid, "activity", newActKey || undefined)

                            const oldActSk = sessionKey(uid, "activity", oldAct || undefined)
                            const oldSession = activeSessions[oldActSk]
                            if (oldSession) {
                                const elapsed = Date.now() - oldSession.startTime
                                const dur = elapsed > 60000 ? formatDuration(elapsed) : ""
                                await activityStore.updateLog(uid, oldSession.logId, {
                                    type: "session",
                                    title: dur ? `${oldSongName} · ${dur}` : oldSongName,
                                    body: `${ACT_VERB[oldType] ?? "playing"} ${oldSongName}`,
                                    metadata: {
                                        ...oldSession.metadata,
                                        action: "activity_session",
                                        startTime: oldSession.startTime,
                                        endTime: Date.now(),
                                        duration: dur || "< 1m",
                                        name: oldSongName,
                                        type: oldType,
                                        appName: oldSession.metadata?.appName || oldSongName,
                                    }
                                })
                                delete activeSessions[oldActSk]
                            }

                            let activityDesc = realAct.name || ""
                            let logBody = `${verb} ${realAct.name}`
                            if (realAct.type === 1 && realAct.details) {
                                activityDesc = `${realAct.name}: ${realAct.details}`
                                logBody = `streaming ${realAct.details}`
                            } else if ((realAct.type === 0 || realAct.type === 3 || realAct.type === 5) && realAct.details) {
                                activityDesc = `${realAct.name} — ${realAct.details}`
                                logBody = `${realAct.name}: ${realAct.details}`
                                if (realAct.state) logBody += ` · ${realAct.state}`
                            }

                            const actTitle = realAct.details
                                ? `${verb} ${realAct.name} — ${realAct.details}`
                                : `${verb} ${realAct.name}`

                            notify({
                                title: `${dn} is ${verb} ${realAct.name}`,
                                body: activityDesc,
                                icon: user ? avatarUrl(user.id, (user as any).avatar, 80) : undefined,
                                onClick: () => openUserProfile(uid),
                            })
                            const gameLargeImg = realAct.assets?.large_image || ""
                            const gameAppId = realAct.application_id || ""
                            let gameIconUrl = ""
                            if (gameLargeImg) {
                                if (gameLargeImg.startsWith("mp:external/")) {
                                    gameIconUrl = `https://media.discordapp.net/external/${gameLargeImg.slice(12)}`
                                } else if (gameLargeImg.startsWith("mp:app-asset/")) {
                                    gameIconUrl = `https://media.discordapp.net/app-assets/${gameLargeImg.slice(13)}`
                                } else if (gameLargeImg.startsWith("mp:")) {
                                    gameIconUrl = `https://media.discordapp.net/${gameLargeImg.slice(3)}`
                                } else if (gameLargeImg.startsWith("spotify:")) {
                                    gameIconUrl = `https://i.scdn.co/image/${gameLargeImg.slice(8)}`
                                } else if (gameAppId && !gameLargeImg.includes(":")) {
                                    gameIconUrl = `https://cdn.discordapp.com/app-assets/${gameAppId}/${gameLargeImg}.png`
                                } else {
                                    gameIconUrl = gameLargeImg
                                }
                            }

                            const entry = await logUserActivity(uid, "activity", icon, actTitle, logBody, {
                                metadata: {
                                    name: realAct.name,
                                    appName: realAct.name,
                                    details: realAct.details,
                                    state: realAct.state,
                                    type: realAct.type,
                                    platform: actPlatform,

                                    action: "activity_start",
                                    applicationId: realAct.application_id || "",
                                    sessionId: realAct.session_id || "",
                                    timestamps: realAct.timestamps || {},
                                    party: realAct.party || {},
                                    assets: realAct.assets || {},
                                    largeImage: gameLargeImg,
                                    gameIconUrl,
                                    flags: realAct.flags || 0,
                                    url: realAct.url || "",
                                }
                            })
                            activeSessions[actSk] = {
                                logId: entry.id,
                                startTime: Date.now(),
                                metadata: {
                                    name: realAct.name,
                                    appName: realAct.name,
                                    details: realAct.details,
                                    state: realAct.state,
                                    platform: actPlatform,
                                    gameIconUrl,
                                }
                            }
                        }
                    }
                }
            }
        },

        USER_UPDATE({ user }: { user: any }) {
            if (!user?.id || !isWatched(settings, user.id)) return
            const relevant = ["username", "global_name", "globalName", "avatar", "discriminator"]
            const hasProfileChange = relevant.some(f => user[f] !== undefined)
            if (!hasProfileChange) return
            const old = profileCache[user.id]
            if (!old) return
            checkProfileChanged(user.id, { ...old, user: { ...old.user, ...camelize(user) } })
        },

        USER_PROFILE_FETCH_SUCCESS(rawEvt: any) {
            if (!rawEvt?.user?.id) return
            if (!profileCache[rawEvt.user.id]) {
                profileCache[rawEvt.user.id] = camelize(rawEvt)
            }
        },

        GUILD_MEMBER_ADD({ guildId, user }: GuildMemberEvent) {
            if (!user?.id || !isWatched(settings, user.id)) return
            if (!isFeatureOn(user.id, "joins", "globalJoins")) return

            if (!guildCache[user.id]) return

            if (guildCache[user.id].has(guildId)) return
            guildCache[user.id].add(guildId)

            const g     = findByProps("getGuild")?.getGuild(guildId)
            const label = getWatchedUser(settings, user.id)?.nick
            const name  = displayName(user)
            const dn    = label ? `${label} (${name})` : name
            notify({
                title: `${dn} Joined a Server`,
                body: g?.name || guildId,
                icon: avatarUrl(user.id, user.avatar, 80),
                onClick: () => jumpTo(guildId),
            })
            logActivity(user.id, "join", "📥", `joined ${g?.name || guildId}`, guildId)
        },

        GUILD_MEMBER_REMOVE({ guildId, user }: GuildMemberEvent) {
            if (!user?.id || !isWatched(settings, user.id)) return
            if (!isFeatureOn(user.id, "joins", "globalJoins")) return

            if (!guildCache[user.id]) return

            if (!guildCache[user.id].has(guildId)) return
            guildCache[user.id].delete(guildId)

            const g     = findByProps("getGuild")?.getGuild(guildId)
            const label = getWatchedUser(settings, user.id)?.nick
            const name  = displayName(user)
            const dn    = label ? `${label} (${name})` : name
            notify({
                title: `${dn} Left a Server`,
                body: g?.name || guildId,
                icon: avatarUrl(user.id, user.avatar, 80),
                onClick: () => jumpTo(guildId),
            })
            logActivity(user.id, "leave", "📤", `left ${g?.name || guildId}`, guildId)
        },
    },
})
