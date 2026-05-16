// native.ts
// Node.js side of UserRadar — handles file system operations
// This file runs in the main process, not the browser

import { IpcMainInvokeEvent, net } from "electron"
import { writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"

const PLUGIN_NAME = "UserRadar"
const REPO_BASE = "https://raw.githubusercontent.com/k1ng0p/UserRadar/main"

const PLUGIN_FILES = [
    "index.tsx",
    "store.ts",
    "types.ts",
    "native.ts",
    "README.md",
]

async function fetchFile(fileName: string): Promise<string> {
    const url = `${REPO_BASE}/${fileName}?t=${Date.now()}`
    const response = await net.fetch(url)
    if (!response.ok) {
        throw new Error(`${fileName}: HTTP ${response.status}`)
    }
    return await response.text()
}

export async function updatePluginFile(_event: IpcMainInvokeEvent): Promise<{ success: boolean; message: string; details?: string }> {
    try {
        const results: string[] = []

        // Find the plugin directory
        let pluginDir: string | null = null
        const possiblePaths = [
            join(process.cwd(), "src", "userplugins", PLUGIN_NAME),
            join(process.cwd(), "..", "src", "userplugins", PLUGIN_NAME),
            join(process.cwd(), "..", "..", "src", "userplugins", PLUGIN_NAME),
        ]
        for (const p of possiblePaths) {
            if (existsSync(p)) {
                pluginDir = p
                break
            }
        }
        if (!pluginDir) {
            throw new Error("Could not find plugin directory. Make sure you're running from Vencord source.")
        }

        // Download and write each file
        for (const fileName of PLUGIN_FILES) {
            try {
                const code = await fetchFile(fileName)
                if (!code || code.length < 10) {
                    results.push(`⚠ ${fileName}: empty (skipped)`)
                    continue
                }
                const filePath = join(pluginDir, fileName)
                writeFileSync(filePath, code, "utf-8")
                results.push(`✓ ${fileName}`)
            } catch (err: any) {
                if (err?.message?.includes("404") || err?.message?.includes("HTTP 404")) {
                    results.push(`⚠ ${fileName}: not found on remote (skipped)`)
                } else {
                    results.push(`✗ ${fileName}: ${err?.message || String(err)}`)
                }
            }
        }

        return { 
            success: true, 
            message: `Updated ${results.filter(r => r.startsWith("✓")).length} files. Restart Discord to apply.`,
            details: results.join("\n")
        }
    } catch (err: any) {
        return { success: false, message: err?.message || String(err) }
    }
}
