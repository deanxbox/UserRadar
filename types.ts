// types.ts - k1ng_op

export type Status = "online" | "idle" | "dnd" | "offline" | "invisible"

export interface MsgCreateEvent {
    type: string
    guildId: string
    channelId: string
    optimistic: boolean
    message: {
        id: string
        type: number
        content: string
        channel_id: string
        attachments: { filename: string; url: string }[]
        author: { id: string; username: string; global_name?: string; avatar?: string }
    }
}

export interface MsgUpdateEvent {
    type: string
    guildId: string
    message: {
        id: string
        content: string
        channel_id: string
        edited_timestamp: string
        attachments: { filename: string }[]
        author: { id: string; username: string; global_name?: string }
    }
}

export interface MsgDeleteEvent {
    id: string
    channelId: string
    guildId: string
}

export interface TypingEvent {
    channelId: string
    userId: string
}

export interface VoiceStateEvent {
    voiceStates: {
        userId: string
        channelId: string | null
        guildId: string
    }[]
}

export interface PresenceEvent {
    updates: {
        user: { id: string }
        status: Status
        activities?: any[]
    }[]
}

export interface ProfileFetchEvent {
    user: {
        id: string
        username: string
        global_name?: string
        globalName?: string
        avatar?: string
        bio?: string
        banner?: string
        banner_color?: string
        accent_color?: number | null
        accentColor?: number | null
    }
    [k: string]: any
}

export interface WatchedUser {
    id: string
    nick: string        // custom label only you see, e.g. "my ex", "the rat"
    addedAt: number
    // null = don't override, just use the global toggle
    overrides: {
        msgs:    boolean | null
        edits:   boolean | null
        deletes: boolean | null
        typing:  boolean | null
        profile: boolean | null
        voice:   boolean | null
        status:  boolean | null
        boosts:  boolean | null
        avatar:  boolean | null  // avatar-only changes (separate from full profile)
    }
}
