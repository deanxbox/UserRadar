// native.ts
// Node.js side of UserRadar — handles file system operations
// This file runs in the main process, not the browser

import { writeFileSync, existsSync, readFileSync } from "fs"
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

        const doRequest = (targetUrl: string) => {
            https.get(targetUrl, { 
                headers: { "User-Agent": "Vencord-UserRadar" },
                timeout: 15000 
            }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                    const redirect = res.headers.location
                    if (!redirect) { reject(new Error("Redirect missing location")); return }
                    doRequest(redirect)
                    return
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`${fileName}: HTTP ${res.statusCode}`))
                    return
                }

                let data = ""
                res.setEncoding("utf8")
                res.on("data", chunk => data += chunk)
                res.on("end", () => resolve(data))
                res.on("error", err => reject(err))
            }).on("error", err => reject(err))
        }

        doRequest(url)
    })
}

function findPluginDir(): string | null {
    const tried: string[] = []

    const check = (base: string, ...segs: string[]): string | null => {
        const p = join(base, ...segs)
        tried.push(p)
        if (existsSync(p)) return p
        return null
    }

    // 1. process.cwd() and relatives
    const cwd = process.cwd()
    let found = check(cwd, "src", "userplugins", PLUGIN_NAME)
    if (found) return found
    found = check(cwd, "..", "src", "userplugins", PLUGIN_NAME)
    if (found) return found
    found = check(cwd, "..", "..", "src", "userplugins", PLUGIN_NAME)
    if (found) return found
    found = check(cwd, "Vencord", "src", "userplugins", PLUGIN_NAME)
    if (found) return found

    // 2. __dirname and relatives (where bundled native.ts lives)
    const nativeDir = __dirname
    found = check(nativeDir, "..", "..", "..", "src", "userplugins", PLUGIN_NAME)
    if (found) return found
    found = check(nativeDir, "..", "..", "src", "userplugins", PLUGIN_NAME)
    if (found) return found
    found = check(nativeDir, "..", "src", "userplugins", PLUGIN_NAME)
    if (found) return found

    // 3. Walk up from __dirname looking for Vencord package.json
    let current = nativeDir
    for (let i = 0; i < 8; i++) {
        const pkgPath = join(current, "package.json")
        if (existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
                if (pkg.name?.toLowerCase()?.includes("vencord")) {
                    found = check(current, "src", "userplugins", PLUGIN_NAME)
                    if (found) return found
                }
            } catch {}
        }
        const parent = join(current, "..")
        if (parent === current) break
        current = parent
    }

    // 4. Walk up from cwd looking for Vencord
    current = cwd
    for (let i = 0; i < 8; i++) {
        const pkgPath = join(current, "package.json")
        if (existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
                if (pkg.name?.toLowerCase()?.includes("vencord")) {
                    found = check(current, "src", "userplugins", PLUGIN_NAME)
                    if (found) return found
                }
            } catch {}
        }
        const parent = join(current, "..")
        if (parent === current) break
        current = parent
    }

    // 5. Common home directory locations
    const home = process.env.HOME || process.env.USERPROFILE
    if (home) {
        found = check(home, "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
        found = check(home, "Documents", "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
        found = check(home, "dev", "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
        found = check(home, "projects", "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
        found = check(home, "Desktop", "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
        found = check(home, "Downloads", "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
    }

    // 6. AppData / config locations
    const appData = process.env.APPDATA || (process.platform === "darwin" ? join(home || "", "Library", "Application Support") : join(home || "", ".config"))
    if (appData) {
        found = check(appData, "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
    }

    // 7. Discord-specific paths (where Vencord might be cloned)
    const discordData = process.env.DISCORD_USER_DATA_DIR || join(appData || "", "discord")
    if (existsSync(discordData)) {
        found = check(discordData, "..", "Vencord", "src", "userplugins", PLUGIN_NAME)
        if (found) return found
    }

    // Store tried paths for error reporting
    ;(globalThis as any).__urTriedPaths = tried
    return null
}

export function getLocalFileContent(fileName: string): { content: string | null; error?: string } {
    try {
        const pluginDir = findPluginDir()
        if (!pluginDir) {
            return { content: null, error: "Could not find plugin directory" }
        }
        const filePath = join(pluginDir, fileName)
        if (!existsSync(filePath)) {
            return { content: null, error: `File not found: ${filePath}` }
        }
        return { content: readFileSync(filePath, "utf-8") }
    } catch (err: any) {
        return { content: null, error: err?.message || String(err) }
    }
}

export async function updatePluginFile(): Promise<{ success: boolean; message: string; details?: string; triedPaths?: string[] }> {
    try {
        const results: string[] = []

        const pluginDir = findPluginDir()
        if (!pluginDir) {
            const tried = (globalThis as any).__urTriedPaths as string[] || []
            return { 
                success: false, 
                message: `Could not find plugin directory. Vencord source not found after searching ${tried.length} locations. Make sure your plugin is at: Vencord/src/userplugins/UserRadar/`,
                triedPaths: tried
            }
        }

        for (const fileName of PLUGIN_FILES) {
            try {
                const code = await fetchFile(fileName)
                if (!code || code.length < 10) {
                    results.push(`⚠ ${fileName}: empty (skipped)`)
                    continue
                }
                writeFileSync(join(pluginDir, fileName), code, "utf-8")
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
