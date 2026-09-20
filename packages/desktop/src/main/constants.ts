import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export function updaterEnabled() {
  return app.isPackaged && CHANNEL !== "dev" && !process.env.OPENCODE_PORTABLE_HOME
}
