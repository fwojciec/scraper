/** AccessibilityNode→AriaNode transformer. Converts CDP accessibility tree nodes to our AriaNode format. */

import type { AccessibilityNode, AccessibilityValue } from "../domain/accessibility.ts";
import type { RefMap } from "../domain/snapshot.ts";

export type { AccessibilityNode, AccessibilityValue };

/** ARIA node in the accessibility tree. */
export interface AriaNode {
  role: string;
  name?: string;
  level?: number;
  ref?: string;
  children?: AriaNode[];
}

export interface TreeOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** Starting value for the ref counter. First minted ref is `e{startRefCounter+1}`. */
  startRefCounter?: number;
}

export interface TransformResult {
  nodes: AriaNode[];
  refs: RefMap;
  /** Highest ref counter value used by this transform. */
  lastRefCounter: number;
}

const TRANSPARENT_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "RootWebArea",
]);

const SKIP_ROLES = new Set(["InlineTextBox"]);

const INTERACTABLE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "textarea",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "tab",
  "treeitem",
  "gridcell",
  "row",
  "columnheader",
  "rowheader",
]);

interface BuildContext {
  refCounter: number;
  nodeCount: number;
  maxNodes: number;
}

/**
 * Decide whether an accessible name came from an explicit author-provided
 * source (ARIA attribute, related element, placeholder) vs. being absorbed
 * from descendant text content.
 *
 * CDP's `AXValue.type` is an AXValueType (almost always `"computedString"`
 * for names), so the source lives inside `AXValue.sources[]`. When sources
 * are absent (synthetic unit-test fixtures), fall back to the legacy
 * heuristic of treating `type !== "contents"` as explicit.
 */
function hasExplicitNameSource(name: AccessibilityValue | undefined): boolean {
  if (!name) return false;
  if (!name.sources || name.sources.length === 0) {
    return name.type !== "contents";
  }
  // Real CDP sources include placeholder entries (no value) listing every
  // location CDP looked — only `contributed` sources actually produced the
  // name, so restrict to those.
  return name.sources.some(
    (s) =>
      s.contributed === true &&
      !s.superseded &&
      !s.invalid &&
      (s.type === "attribute" || s.type === "relatedElement" || s.type === "placeholder"),
  );
}

function transformNode(
  ax: AccessibilityNode,
  depth: number,
  maxDepth: number,
  ctx: BuildContext,
  refs: RefMap,
  lookup: Map<string, AccessibilityNode>,
): AriaNode[] {
  if (ctx.nodeCount >= ctx.maxNodes) return [];

  const roleValue = ax.role?.value as string | undefined;

  // Ignored nodes: process children (they may be visible)
  if (ax.ignored) {
    return transformChildren(ax, depth, maxDepth, ctx, refs, lookup);
  }

  // Skip roles we don't render
  if (!roleValue || SKIP_ROLES.has(roleValue)) return [];

  // Transparent roles: flatten children up
  if (TRANSPARENT_ROLES.has(roleValue)) {
    return transformChildren(ax, depth, maxDepth, ctx, refs, lookup);
  }

  // StaticText → text pseudo-node
  if (roleValue === "StaticText") {
    const text = (ax.name?.value as string) ?? "";
    if (!text.trim()) return [];
    return [{ role: "text", name: text }];
  }

  ctx.nodeCount++;

  // Map role (image → img for consistency with old output)
  const role = roleValue === "image" ? "img" : roleValue;
  const node: AriaNode = { role };

  // Level from properties (headings)
  const levelProp = ax.properties?.find((p) => p.name === "level");
  if (levelProp?.value?.value !== undefined) {
    node.level = levelProp.value.value as number;
  }

  // Name
  const rawName = ax.name?.value;
  const nameValue = rawName != null && rawName !== "" ? String(rawName) : undefined;
  const nameIsExplicit = nameValue !== undefined && hasExplicitNameSource(ax.name);

  // Ref for widget-category roles, plus any node with an explicit accessible name
  // (only when we can resolve them to a backend DOM node).
  const shouldMintRef = INTERACTABLE_ROLES.has(role) || nameIsExplicit;
  if (shouldMintRef && ax.backendDOMNodeId !== undefined) {
    ctx.refCounter++;
    node.ref = `e${ctx.refCounter}`;
    refs[node.ref] = ax.backendDOMNodeId;
  }

  // Process children if within depth limit
  if (depth < maxDepth) {
    const children = transformChildren(
      ax,
      depth + 1,
      maxDepth,
      ctx,
      refs,
      lookup,
    );
    if (children.length > 0) {
      if (nameIsExplicit) {
        // Explicit name (aria-label etc.) — use it, keep only semantic children
        node.name = nameValue;
        const semantic = children.filter((c) => c.role !== "text");
        if (semantic.length > 0) node.children = semantic;
      } else {
        const allText = children.every((c) => c.role === "text");
        if (allText) {
          // All text children — absorb into name
          const text = children.map((c) => c.name ?? "").join("").trim();
          if (text) node.name = text;
        } else {
          // Mixed children — show all
          node.children = children;
        }
      }
    } else if (nameValue) {
      node.name = nameValue;
    }
  } else if (nameValue) {
    node.name = nameValue;
  }

  return [node];
}

function transformChildren(
  ax: AccessibilityNode,
  depth: number,
  maxDepth: number,
  ctx: BuildContext,
  refs: RefMap,
  lookup: Map<string, AccessibilityNode>,
): AriaNode[] {
  const results: AriaNode[] = [];
  if (!ax.childIds) return results;

  for (const childId of ax.childIds) {
    if (ctx.nodeCount >= ctx.maxNodes) break;
    const child = lookup.get(childId);
    if (!child) continue;
    results.push(
      ...transformNode(child, depth, maxDepth, ctx, refs, lookup),
    );
  }
  return results;
}

/** Transform a flat AccessibilityNode array into an AriaNode tree with ref mapping. */
export function transformAXTree(
  axNodes: AccessibilityNode[],
  options?: TreeOptions,
  rootNodeId?: string,
): TransformResult {
  const startRefCounter = options?.startRefCounter ?? 0;
  if (axNodes.length === 0) {
    return { nodes: [], refs: {}, lastRefCounter: startRefCounter };
  }

  // Build lookup: nodeId → AccessibilityNode
  const lookup = new Map<string, AccessibilityNode>();
  for (const node of axNodes) {
    lookup.set(node.nodeId, node);
  }

  // Find starting node
  const root = rootNodeId ? lookup.get(rootNodeId) : axNodes[0];
  if (!root) return { nodes: [], refs: {}, lastRefCounter: startRefCounter };

  const refs: RefMap = {};
  const ctx: BuildContext = {
    refCounter: startRefCounter,
    nodeCount: 0,
    maxNodes: options?.maxNodes ?? Infinity,
  };
  const maxDepth = options?.maxDepth ?? Infinity;

  const nodes = transformNode(root, 0, maxDepth, ctx, refs, lookup);
  return { nodes, refs, lastRefCounter: ctx.refCounter };
}
