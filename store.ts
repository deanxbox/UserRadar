// store.ts - k1ng_op

import { Logger } from "@utils/Logger"
import { WatchedUser } from "./types"

export const log = new Logger("UserRadar", "#a78bfa")

function parse(raw: string): WatchedUser[] {
    if (!raw || raw.trim() === "") return []
    try { return JSON.parse(raw) as WatchedUser[] }
    catch { log.error("watchlist json is borked, wiping it"); return [] }
}

// always read fresh, never cache - stale reads burned me too many times
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
    if (list.some(u => u.id === userId)) return
    list.push({
        id: userId,
        nick,
        addedAt: Date.now(),
        overrides: {
            msgs: null, edits: null, deletes: null, typing: null,
            profile: null, voice: null, status: null, boosts: null, avatar: null,
            activity: null, joins: null,
        },
    })
    saveWatchlist(settings, list)
    log.info("now watching", userId)
}

export function removeUser(settings: any, userId: string) {
    saveWatchlist(settings, getWatchlist(settings).filter(u => u.id !== userId))
    log.info("unwatched", userId)
}

export function patchUser(settings: any, userId: string, patch: Partial<WatchedUser>) {
    const list = getWatchlist(settings).map(u =>
        u.id === userId ? { ...u, ...patch } : u
    )
    saveWatchlist(settings, list)
}

// null override = fall through to global setting
export function featureOn(
    settings: any,
    userId: string,
    feature: keyof WatchedUser["overrides"],
    globalKey: string
): boolean {
    const u = getWatchedUser(settings, userId)
    if (!u) return false
    const ov = (u.overrides ?? {} as any)[feature]
    return ov !== null && ov !== undefined ? ov : (settings.store[globalKey] ?? false)
}

// discord api is snake_case, js is camelCase, this fixes that recursively
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

export function inQuietHours(settings: any): boolean {
    if (!settings.store.quietHours) return false
    const now = new Date()
    const cur = now.getHours() * 60 + now.getMinutes()
    const toMins = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m }
    const start = toMins(settings.store.quietStart ?? "23:00")
    const end   = toMins(settings.store.quietEnd   ?? "07:00")
    return start > end ? cur >= start || cur < end : cur >= start && cur < end
}

export function displayName(user: any): string {
    if (!user) return "Unknown"
    return user.globalName ?? user.global_name ?? user.username ?? user.id ?? "Unknown"
}

export const STATUS_EMOJI: Record<string, string> = {
    online: "🟢", idle: "🌙", dnd: "🔴", offline: "⚫", invisible: "👻",
}
