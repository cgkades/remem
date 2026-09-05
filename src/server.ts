import type { PluginModule } from "opencode-plugin-v1"
import { RememV1Plugin } from "./hosts/opencode/v1.js"

export default {
  id: "agentic-remem",
  server: RememV1Plugin,
} satisfies PluginModule
