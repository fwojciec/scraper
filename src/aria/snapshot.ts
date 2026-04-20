/** SnapshotService: uses CDP Accessibility tree to build ARIA snapshots. */

import type { SnapshotService } from "../domain/browser.ts";
import { type AccessibilityNode, transformAXTree } from "./tree.ts";
import { renderYaml } from "./render.ts";

/** Dependencies for the snapshot service, provided by the CDP adapter. */
export interface SnapshotDeps {
  getFullAXTree(): Promise<AccessibilityNode[]>;
  resolveSelector(selector: string): Promise<number>;
}

function yamlString(s: string): string {
  const escaped = s
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
  return `"${escaped}"`;
}

/** Create a SnapshotService that transforms CDP Accessibility tree data. */
export function createSnapshotService(deps: SnapshotDeps): SnapshotService {
  return {
    async snapshot(request) {
      const startingRefCounter = request.startingRefCounter ?? 0;
      const axNodes = await deps.getFullAXTree();

      let rootNodeId: string | undefined;
      let selectorMissed = false;

      if (request.selector) {
        const backendNodeId = await deps.resolveSelector(request.selector);
        const match = axNodes.find((n) => n.backendDOMNodeId === backendNodeId);
        if (!match) {
          selectorMissed = true;
        } else {
          rootNodeId = match.nodeId;
        }
      }

      const { nodes, refs, lastRefCounter } = selectorMissed
        ? { nodes: [], refs: {}, lastRefCounter: startingRefCounter }
        : transformAXTree(axNodes, {
          maxDepth: request.maxDepth,
          maxNodes: request.maxNodes,
          startRefCounter: startingRefCounter,
        }, rootNodeId);

      const header = [
        `snapshot: ${request.snapshotId}`,
        `targetId: ${request.targetId}`,
        `url: ${yamlString(request.url)}`,
        `title: ${yamlString(request.title)}`,
        `dialog: ${request.dialog === null ? "null" : yamlString(request.dialog)}`,
      ].join("\n");

      const treeBody = renderYaml(nodes, { baseIndent: 2 });
      const tree = treeBody.length === 0 ? "tree: []" : "tree:\n" + treeBody.trimEnd();

      const yaml = `${header}\n${tree}\n`;
      return { yaml, refs, lastRefCounter };
    },
  };
}
