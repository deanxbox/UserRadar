// native.ts
// Node.js side of UserRadar — must be rebuilt with pnpm build && pnpm inject

import { writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import https from "https"

const PLUGIN_NAME = "UserRadar"
const REPO_BASE = "raw.githubusercontent.com"
const REPO_PATH = "/k1ng0p/UserRadar/main"

const PLUGIN_FILES = ["index.tsx", "store.ts", "types.ts", "native.ts", "README.md"]

// Hardcoded common paths — add your own if different
const POSSIBLE_PATHS = [
    join(process.cwd(), "src", "userplugins", PLUGIN_NAME),
    join(process.cwd(), "..", "src", "userplugins", PLUGIN_NAME),
    join(process.cwd(), "..", "..", "src", "userplugins", PLUGIN_NAME),
    join(process.cwd(), "Vencord", "src", "userplugins", PLUGIN_NAME),
    join(process.cwd(), "..", "Vencord", "src", "userplugins", PLUGIN_NAME),
]

function findDir(): string | null {
    for (const p of POSSIBLE_PATHS) {
        if (existsSync(p)) return p
    }
    return null
}

function fetchFile(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = `https://${REPO_BASE}${REPO_PATH}/${file}?t=${Date.now()}`
        https.get(url, { headers: { "User-Agent": "Vencord-UserRadar" } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const loc = res.headers.location
                if (!loc) { reject(new Error("no redirect location")); return }
                https.get(loc, { headers: { "User-Agent": "Vencord-UserRadar" } }, (r2) => {
                    if (r2.statusCode !== 200) { reject(new Error(`HTTP ${r2.statusCode}`)); return }
                    let d = ""; r2.on("data", c => d += c); r2.on("end", () => resolve(d)); r2.on("error", e => reject(e))
                }).on("error", e => reject(e))
                return
            }
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
            let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); res.on("error", e => reject(e))
        }).on("error", e => reject(e))
    })
}

// Diagnostic — call this from browser to test if native.ts is loaded
export function ping(): string {
    return "pong"
}

export function getLocalFileContent(fileName: string): { content: string | null; error?: string } {
    const dir = findDir()
    if (!dir) return { content: null, error: "plugin dir not found" }
    const p = join(dir, fileName)
    if (!existsSync(p)) return { content: null, error: `file not found: ${p}` }
    try { return { content: readFileSync(p, "utf-8") } }
    catch (e: any) { return { content: null, error: e.message } }
}

export async function updatePluginFile(): Promise<{ success: boolean; message: string; details?: string }> {
    const dir = findDir()
    if (!dir) return { success: false, message: "plugin dir not found. Searched: " + POSSIBLE_PATHS.join(", ") }

    const results: string[] = []
    for (const file of PLUGIN_FILES) {
        try {
            const code = await fetchFile(file)
            if (!code || code.length < 10) { results.push(`skip ${file}`); continue }
            writeFileSync(join(dir, file), code, "utf-8")
            results.push(`ok ${file}`)
        } catch (e: any) {
            results.push(`err ${file}: ${e.message}`)
        }
    }
    const ok = results.filter(r => r.startsWith("ok")).length
    return { success: ok > 0, message: `Updated ${ok} files. Restart Discord.`, details: results.join("\n") }
}
