/** CDP→domain translator for accessibility tree nodes. */

import type { AccessibilityNode, AccessibilityValue } from "../domain/accessibility.ts";

// deno-lint-ignore no-explicit-any
type RawNode = Record<string, any>;

/** Translate a raw CDP AXValue to a domain AccessibilityValue. */
function translateValue(raw: RawNode): AccessibilityValue {
  const out: AccessibilityValue = { type: raw.type };
  if (raw.value !== undefined) out.value = raw.value;
  return out;
}

/** Translate raw CDP AXNode array to domain AccessibilityNode array. */
// deno-lint-ignore no-explicit-any
export function translateAXNodes(raw: any[]): AccessibilityNode[] {
  return raw.map(translateNode);
}

function translateNode(raw: RawNode): AccessibilityNode {
  const node: AccessibilityNode = { nodeId: raw.nodeId };

  if (raw.ignored !== undefined) node.ignored = raw.ignored;
  if (raw.role !== undefined) node.role = translateValue(raw.role);
  if (raw.name !== undefined) node.name = translateValue(raw.name);
  if (raw.childIds !== undefined) node.childIds = raw.childIds;
  if (raw.parentId !== undefined) node.parentId = raw.parentId;
  if (raw.backendDOMNodeId !== undefined) node.backendDOMNodeId = raw.backendDOMNodeId;

  if (raw.properties !== undefined) {
    node.properties = raw.properties.map((p: RawNode) => ({
      name: p.name,
      value: translateValue(p.value),
    }));
  }

  return node;
}
