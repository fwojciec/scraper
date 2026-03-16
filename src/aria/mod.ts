// Adapter: CDP Accessibility tree → ARIA snapshot.
export {
  type AccessibilityNode,
  type AriaNode,
  transformAXTree,
  type TransformResult,
  type TreeOptions,
} from "./tree.ts";
export { renderYaml } from "./render.ts";
export { createSnapshotService, type SnapshotDeps } from "./snapshot.ts";
