// native.ts
// Node.js side of UserRadar — handles file system operations
// This file runs in the main process, not the browser

import { writeFileSync, existsSync } from "fs"
import { join } from "path"
import https from "https"

const PLUGIN_NAME = "UserRadar"
const REPO_BASE = "raw.githubusercontent.com"
const REPO_PATH = "/k1ng0p/UserRadar/main"

const PLUGIN_FILES = [
    "index.tsx",
    "store.ts",
    "types.ts",
    "native.ts",
    "README.md",
]

function fetchFile(fileName: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = `https://${REPO_BASE}${REPO_PATH}/${fileName}?t=${Date.now()}`
        https.get(url, { headers: { "User-Agent": "Vencord-UserRadar" } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                // Follow redirect
                const redirectUrl = res.headers.location
                if (!redirectUrl) { reject(new Error("Redirect without location")); return }
                https.get(redirectUrl, { headers: { "User-Agent": "Vencord-UserRadar" } }, (res2) => {
                    if (res2.statusCode !== 200) {
                        reject(new Error(`${fileName}: HTTP ${res2.statusCode}`))
                        return
                    }
                    let data = ""
                    res2.on("data", chunk => data += chunk)
                    res2.on("end", () => resolve(data))
                    res2.on("error", err => reject(err))
                }).on("error", err => reject(err))
                return
            }
            if (res.statusCode !== 200) {
                reject(new Error(`${fileName}: HTTP ${res.statusCode}`))
                return
            }
            let data = ""
            res.on("data", chunk => data += chunk)
            res.on("end", () => resolve(data))
            res.on("error", err => reject(err))
        }).on("error", err => reject(err))
    })
}

export async function updatePluginFile() {
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
        return { success: false, message: err?.message || String(err), details: "" }
    }
}
