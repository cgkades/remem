import { RememPlugin } from "./hosts/opencode/v2.js"

export { RememPlugin, injectV2DispatchMemory } from "./hosts/opencode/v2.js"
export { RememV1Plugin, createOpenCodeV1Hooks, injectV1PromptMemory } from "./hosts/opencode/v1.js"
export * from "./core.js"

export default RememPlugin
