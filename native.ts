// native.ts — k1ng_op
// vencord compiles this into the main electron process
// the IPC event is stripped by vencord's wrapper before calling our functions

import { join } from "path"
import { writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"

function getDataDir(): string {
    if (process.env.VENCORD_USER_DATA_DIR) return process.env.VENCORD_USER_DATA_DIR
    if (process.platform === "win32")  return join(process.env.APPDATA!, "Vencord")
    if (process.platform === "darwin") return join(process.env.HOME!, "Library", "Application Support", "Vencord")
    return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME!, ".config"), "Vencord")
}

export async function writePlugin(code: string): Promise<{ ok: boolean; error?: string }> {
    try {
        if (!code || typeof code !== "string" || code.length < 500)
            return { ok: false, error: "invalid code received" }

        const pluginDir = join(getDataDir(), "userplugins", "UserRadar")
        if (!existsSync(pluginDir)) await mkdir(pluginDir, { recursive: true })
        await writeFile(join(pluginDir, "index.tsx"), code, "utf8")
        return { ok: true }
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) }
    }
}
