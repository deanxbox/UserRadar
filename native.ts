// native.ts — k1ng_op

import { join } from "path"
import { writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"

export async function writePlugin(code: string): Promise<{ ok: boolean; error?: string }> {
    try {
        // log what we actually received so we can debug
        const type = typeof code
        const len  = type === "string" ? (code as string).length : 0
        
        if (type !== "string") {
            return { ok: false, error: `expected string, got ${type} (len=${len})` }
        }
        if (len < 100) {
            return { ok: false, error: `code too short: ${len} chars` }
        }

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
        if (!existsSync(pluginDir)) await mkdir(pluginDir, { recursive: true })
        await writeFile(join(pluginDir, "index.tsx"), code, "utf8")
        return { ok: true }
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) }
    }
}
