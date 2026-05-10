// store.ts - k1ng_op
// all watchlist state lives here so i dont have to thread settings through everything

import { Logger } from "@utils/Logger"
import { WatchedUser } from "./types"

export const log = new Logger("UserRadar", "#a78bfa")

// watchlist is stored as a JSON string bc vencord has no list type
// annoying but it works

function parse(raw: string): WatchedUser[] {
    if (!raw || raw.trim() === "") return []
    try {
        return JSON.parse(raw) as WatchedUser[]
    } catch {
        log.error("watchlist json got corrupted somehow, wiping it")
        return []
    }
}

// always read fresh, never cache - stale state has burned me before
export function getWatchlist(settings: any): WatchedUser[] {
    return parse(settings.store.watchlist ?? "[]")
}

export function saveWatchlist(settings: any, list: WatchedUser[]) {
    settings.store.watchlist = JSON.stringify(list)
}

export function isWatched(settings: any, userId: string): boolean {
    return getWatchlist(settings).some(u => u.id === userId)
}

export function getWatchedUser(settings: any, userId: string): WatchedUser | undefined {
    return getWatchlist(settings).find(u => u.id === userId)
}

export function addUser(settings: any, userId: string, nick = "") {
    const list = getWatchlist(settings)
    if (list.some(u => u.id === userId)) return  // already there, skip
    list.push({
        id: userId,
        nick,
        addedAt: Date.now(),
        overrides: {
            msgs: null,
            edits: null,
            deletes: null,
            typing: null,
            profile: null,
            voice: null,
            status: null,
        },
    })
    saveWatchlist(settings, list)
    log.info("watching", userId)
}

export function removeUser(settings: any, userId: string) {
    const list = getWatchlist(settings).filter(u => u.id !== userId)
    saveWatchlist(settings, list)
    log.info("unwatched", userId)
}

export function patchUser(settings: any, userId: string, patch: Partial<WatchedUser>) {
    const list = getWatchlist(settings).map(u =>
        u.id === userId ? { ...u, ...patch } : u
    )
    saveWatchlist(settings, list)
}

// null override = fall back to global setting
export function featureOn(
    settings: any,
    userId: string,
    feature: keyof WatchedUser["overrides"],
    globalKey: string
): boolean {
    const u = getWatchedUser(settings, userId)
    if (!u) return false
    const ov = u.overrides[feature]
    return ov !== null ? ov : (settings.store[globalKey] ?? true)
}

// discord api returns snake_case, everything in js is camelCase
// this just converts recursively so i dont have to think about it
export function camelize(obj: any): any {
    if (Array.isArray(obj)) return obj.map(camelize)
    if (obj && typeof obj === "object") {
        return Object.fromEntries(
            Object.entries(obj).map(([k, v]) => [
                k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
                camelize(v),
            ])
        )
    }
    return obj
}

// returns true if notifs should be suppressed rn
export function inQuietHours(settings: any): boolean {
    if (!settings.store.quietHours) return false

    const now = new Date()
    const cur = now.getHours() * 60 + now.getMinutes()

    const toMins = (t: string) => {
        const [h, m] = t.split(":").map(Number)
        return h * 60 + m
    }

    const start = toMins(settings.store.quietStart ?? "23:00")
    const end   = toMins(settings.store.quietEnd   ?? "07:00")

    // overnight range like 23:00-07:00 needs special handling
    return start > end
        ? cur >= start || cur < end
        : cur >= start && cur < end
}

export function displayName(user: any): string {
    if (!user) return "Unknown"
    return user.globalName ?? user.global_name ?? user.username ?? user.id ?? "Unknown"
}

export const STATUS_EMOJI: Record<string, string> = {
    online:    "🟢",
    idle:      "🌙",
    dnd:       "🔴",
    offline:   "⚫",
    invisible: "👻",
}
