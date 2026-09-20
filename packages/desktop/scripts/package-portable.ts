#!/usr/bin/env bun
import { $ } from "bun"

process.env.OPENCODE_PORTABLE_BUILD = "1"
await $`bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts`
