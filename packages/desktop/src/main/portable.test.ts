import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { portableSecrets, relocateDesktopState, resolvePortableHome, withPortableHome } from "./portable"

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe("portable desktop", () => {
  test("resolves explicit, packaged, and marker-based homes", () => {
    expect(resolvePortableHome("D:\\app\\OpenCode.exe", { OPENCODE_PORTABLE_HOME: "E:\\profile" })).toBe(
      "E:\\profile",
    )
    expect(resolvePortableHome("D:\\app\\OpenCode.exe", { PORTABLE_EXECUTABLE_DIR: "F:\\OpenCode" })).toBe(
      "F:\\OpenCode\\home",
    )
    expect(
      resolvePortableHome("G:\\OpenCode\\app\\OpenCode.exe", {}, (path) => path === "G:\\OpenCode\\portable.flag"),
    ).toBe("G:\\OpenCode\\home")
  })

  test("adds a portable home only to child process environments", () => {
    const source = { PATH: "bin", OPENCODE_PORTABLE_HOME: "D:\\OpenCode\\home" }
    expect(withPortableHome(source)).toEqual({
      PATH: "bin",
      OPENCODE_PORTABLE_HOME: "D:\\OpenCode\\home",
      HOME: "D:\\OpenCode\\home",
      USERPROFILE: "D:\\OpenCode\\home",
    })
    expect(source).toEqual({ PATH: "bin", OPENCODE_PORTABLE_HOME: "D:\\OpenCode\\home" })
  })

  test("loads portable secrets without overriding inherited values", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-portable-secrets-"))
    roots.push(root)
    mkdirSync(join(root, "secrets"), { recursive: true })
    writeFileSync(join(root, "secrets", "RUNPOD_LLM_KEY.txt"), "runpod-secret\n")
    writeFileSync(join(root, "secrets", "MEISTERPLAN_API_TOKEN.txt"), "file-token\n")

    expect(portableSecrets(root, { MEISTERPLAN_API_TOKEN: "inherited-token" })).toEqual({
      RUNPOD_LLM_KEY: "runpod-secret",
    })
  })

  test("relocates recent projects and backs up stale scoped stores", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-portable-"))
    roots.push(root)
    const userData = join(root, "desktop")
    const backupRoot = join(root, "data")
    mkdirSync(join(userData, "Local Storage"), { recursive: true })
    writeFileSync(
      join(userData, "opencode.global.dat"),
      JSON.stringify({
        server: JSON.stringify({
          projects: {
            local: [{ worktree: "F:\\projects\\demo", expanded: true }],
            remote: [{ worktree: "F:\\remote\\demo", expanded: true }],
          },
          lastProject: { local: "F:/projects/demo" },
        }),
        notification: JSON.stringify([{ directory: "F:\\projects\\demo" }]),
        layout: JSON.stringify({ home: { selection: { directory: "F:/projects/demo" } } }),
      }),
    )
    writeFileSync(join(userData, "opencode.workspace.old.dat"), "{}")
    writeFileSync(join(userData, "opencode.window.old.dat"), "{}")
    writeFileSync(join(userData, "Local Storage", "state"), "stale")

    relocateDesktopState(userData, backupRoot, "F:", "D:")

    const global = JSON.parse(readFileSync(join(userData, "opencode.global.dat"), "utf8")) as Record<string, string>
    expect(JSON.parse(global.server)).toEqual({
      projects: {
        local: [{ worktree: "D:\\projects\\demo", expanded: true }],
        remote: [{ worktree: "F:\\remote\\demo", expanded: true }],
      },
      lastProject: { local: "D:/projects/demo" },
    })
    expect(JSON.parse(global.notification)).toEqual([{ directory: "D:\\projects\\demo" }])
    expect(global.layout).toBeUndefined()
    expect(readdirSync(userData)).not.toContain("opencode.workspace.old.dat")
    expect(readdirSync(userData)).not.toContain("opencode.window.old.dat")
    expect(readdirSync(userData)).not.toContain("Local Storage")
    expect(readdirSync(join(backupRoot, readdirSync(backupRoot)[0]))).toEqual(
      expect.arrayContaining(["Local Storage", "opencode.global.dat", "opencode.window.old.dat", "opencode.workspace.old.dat"]),
    )
  })
})
