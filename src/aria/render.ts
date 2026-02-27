import type { AriaNode } from "./tree.ts";

function formatAttrs(node: AriaNode): string {
  const parts: string[] = [];
  if (node.level !== undefined) parts.push(`level=${node.level}`);
  if (node.ref) parts.push(`ref=${node.ref}`);
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

function escapeYamlName(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => {
      const hex = ch.charCodeAt(0).toString(16).padStart(2, "0");
      return `\\x${hex}`;
    });
}

function renderNode(node: AriaNode, indent: number): string {
  const pad = " ".repeat(indent);

  // Text pseudo-node
  if (node.role === "text") {
    return `${pad}- text "${escapeYamlName(node.name ?? "")}"`;
  }

  const name = node.name ? ` "${escapeYamlName(node.name)}"` : "";
  const attrs = formatAttrs(node);
  const hasChildren = node.children && node.children.length > 0;

  if (!hasChildren) {
    return `${pad}- ${node.role}${name}${attrs}`;
  }

  const header = `${pad}- ${node.role}${name}${attrs}:`;
  const childLines = node.children!.map((c) => renderNode(c, indent + 4));
  return [header, ...childLines].join("\n");
}

/** Render an AriaNode tree to YAML string. */
export function renderYaml(nodes: AriaNode[]): string {
  if (nodes.length === 0) return "";
  return nodes.map((n) => renderNode(n, 0)).join("\n") + "\n";
}
