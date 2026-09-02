import type { PluginModule } from "@opencode-ai/plugin"
import { RememPlugin } from "./integration/opencode.js"

export default {
  id: "opencode-remem",
  server: RememPlugin,
} satisfies PluginModule
