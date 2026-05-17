// native.ts — k1ng_op
// runs in the main electron process, not the renderer
// this is how vencord userplugins get native file access
// vencord automatically picks this up and exposes it via VencordNative.pluginHelpers.UserRadar

import { IpcMainInvokeEvent } from "electron"
import { join } from "path"
import { writeFile } from "fs/promises"
import { existsSync, mkdirSync } from "fs"

// writes updated plugin code to disk
// called from the renderer via VencordNative.pluginHelpers.UserRadar.writePlugin(code)
export async function writePlugin(_: IpcMainInvokeEvent, code: string): Promise<{ ok: boolean; error?: string }> {
    try {
        if (!code || code.length < 500) {
            return { ok: false, error: "code looks empty, not writing" }
        }

        // __dirname here is the vencord dist folder
        // userplugins live at <settingsDir>/userplugins/
        // vencord exposes DATA_DIR via process env
        const dataDir = process.env.VENCORD_USER_DATA_DIR
            ?? join(process.env.APPDATA ?? process.env.HOME ?? "~", ".vencord")

        const pluginDir = join(dataDir, "userplugins", "UserRadar")

        // make sure the dir exists
        if (!existsSync(pluginDir)) {
            mkdirSync(pluginDir, { recursive: true })
        }

        const filePath = join(pluginDir, "index.tsx")
        await writeFile(filePath, code, "utf8")

        return { ok: true }
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) }
    }
}
