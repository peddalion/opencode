#!/usr/bin/env bun
import { $ } from "bun"
import { rm } from "node:fs/promises"

process.env.OPENCODE_PORTABLE_BUILD = "1"
const pkg = await Bun.file("package.json").json()
const metadata = {
  version: pkg.version,
  commit: process.env.GITHUB_SHA ?? "local",
  builtAt: new Date().toISOString(),
}

await Bun.write("resources/portable-build.json", JSON.stringify(metadata, null, 2) + "\n")
try {
  await $`bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts`
  await Bun.write("dist/portable-build.json", JSON.stringify(metadata, null, 2) + "\n")
} finally {
  await rm("resources/portable-build.json", { force: true })
}
