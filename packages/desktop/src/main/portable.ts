import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, parse, resolve } from "node:path"

const markerName = "portable.flag"
const rootMarkerName = "portable-root.txt"

export type PortableState = {
  home: string
  userData: string
  relocated: boolean
  commit(): void
}

export function setupPortable(appId: string): PortableState | undefined {
  const home = resolvePortableHome(process.execPath, process.env)
  if (!home) return

  const root = dirname(home)
  const data = join(home, ".local", "share")
  const userData = join(home, "AppData", "Roaming", appId)
  const marker = join(data, "opencode", rootMarkerName)
  const previous = readMarker(marker)
  const previousDrive = previous ? parse(previous).root.slice(0, 2).toUpperCase() : undefined
  const currentDrive = parse(root).root.slice(0, 2).toUpperCase()
  const relocated = process.platform === "win32" && Boolean(previousDrive) && previousDrive !== currentDrive

  ;[
    data,
    join(home, ".config"),
    join(home, ".cache"),
    join(home, ".local", "state"),
    userData,
    join(root, "temp"),
  ].forEach((directory) => mkdirSync(directory, { recursive: true }))

  Object.assign(process.env, {
    OPENCODE_PORTABLE_HOME: home,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    TEMP: join(root, "temp"),
    TMP: join(root, "temp"),
    ...(relocated
      ? {
          OPENCODE_PORTABLE_MIGRATE_FROM: previousDrive,
          OPENCODE_PORTABLE_MIGRATE_TO: currentDrive,
        }
      : {}),
  })

  if (relocated && previousDrive) relocateDesktopState(userData, join(data, "opencode"), previousDrive, currentDrive)

  return {
    home,
    userData,
    relocated,
    commit() {
      mkdirSync(dirname(marker), { recursive: true })
      writeFileSync(marker, root, "utf8")
    },
  }
}

export function resolvePortableHome(
  executable: string,
  env: NodeJS.ProcessEnv,
  hasMarker: (path: string) => boolean = existsSync,
) {
  if (env.OPENCODE_PORTABLE_HOME) return resolve(env.OPENCODE_PORTABLE_HOME)
  if (env.PORTABLE_EXECUTABLE_DIR) return resolve(env.PORTABLE_EXECUTABLE_DIR, "home")

  const directory = dirname(executable)
  const root = [directory, dirname(directory)].find((candidate) => hasMarker(join(candidate, markerName)))
  if (!root) return
  return join(root, "home")
}

export function withPortableHome(env: NodeJS.ProcessEnv) {
  if (!env.OPENCODE_PORTABLE_HOME) return env
  return {
    ...env,
    HOME: env.OPENCODE_PORTABLE_HOME,
    USERPROFILE: env.OPENCODE_PORTABLE_HOME,
  }
}

function readMarker(path: string) {
  if (!existsSync(path)) return
  const value = readFileSync(path, "utf8").trim()
  return value || undefined
}

export function relocateDesktopState(userData: string, backupRoot: string, from: string, to: string) {
  if (!existsSync(userData)) return

  const backup = join(backupRoot, `repair-backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-drive-letter`)
  mkdirSync(backup, { recursive: true })

  const global = join(userData, "opencode.global.dat")
  if (existsSync(global)) {
    copyFileSync(global, join(backup, "opencode.global.dat"))
    const data = JSON.parse(readFileSync(global, "utf8")) as Record<string, unknown>
    if (typeof data.server === "string") {
      data.server = JSON.stringify(relocateServerState(JSON.parse(data.server), from, to))
    }
    if (data.server && typeof data.server === "object") {
      data.server = relocateServerState(data.server, from, to)
    }
    if (typeof data.notification === "string") {
      data.notification = JSON.stringify(relocateValue(JSON.parse(data.notification), from, to))
    }
    if (data.notification && typeof data.notification === "object") {
      data.notification = relocateValue(data.notification, from, to)
    }
    delete data.layout
    writeFileSync(global, JSON.stringify(data, null, 2) + "\n", "utf8")
  }

  readdirSync(userData)
    .filter((name) => name.startsWith("opencode.workspace.") || name.startsWith("opencode.window."))
    .forEach((name) => renameSync(join(userData, name), join(backup, name)))

  const localStorage = join(userData, "Local Storage")
  if (existsSync(localStorage)) {
    cpSync(localStorage, join(backup, "Local Storage"), { recursive: true })
    rmSync(localStorage, { recursive: true, force: true })
  }
}

function relocateServerState(value: unknown, from: string, to: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const server = value as Record<string, unknown>
  const next = { ...server }
  for (const key of ["projects", "lastProject", "recentlyClosed"]) {
    const scopes = server[key]
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) continue
    next[key] = {
      ...scopes,
      local: relocateValue((scopes as Record<string, unknown>).local, from, to),
    }
  }
  return next
}

function relocateValue(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") {
    if (value.slice(0, 2).toLowerCase() !== from.toLowerCase()) return value
    if (value[2] !== "/" && value[2] !== "\\") return value
    return to + value.slice(2)
  }
  if (Array.isArray(value)) return value.map((item) => relocateValue(item, from, to))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [relocateValue(key, from, to) as string, relocateValue(item, from, to)]),
  )
}
