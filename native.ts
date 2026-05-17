// native.ts — k1ng_op
// vencord automatically compiles this into the main process
// and exposes exports via VencordNative.pluginHelpers.UserRadar
// DO NOT add IpcMainInvokeEvent as first param — vencord injects that itself

import { join } from "path"
import { writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"

export async function writePlugin(code: string): Promise<{ ok: boolean; error?: string }> {
    try {
        if (!code || code.length < 500) {
            return { ok: false, error: "code too short, refusing to write" }
        }

        // vencord sets this in the main process
        // falls back to standard locations per platform
        let dataDir: string

        if (process.env.VENCORD_USER_DATA_DIR) {
            dataDir = process.env.VENCORD_USER_DATA_DIR
        } else if (process.platform === "win32") {
            dataDir = join(process.env.APPDATA!, "Vencord")
        } else if (process.platform === "darwin") {
            dataDir = join(process.env.HOME!, "Library", "Application Support", "Vencord")
        } else {
            dataDir = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME!, ".config"), "Vencord")
        }

        const pluginDir = join(dataDir, "userplugins", "UserRadar")

        if (!existsSync(pluginDir)) {
            await mkdir(pluginDir, { recursive: true })
        }

        await writeFile(join(pluginDir, "index.tsx"), code, "utf8")

        return { ok: true }
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) }
    }
}
