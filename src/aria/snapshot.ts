/** SnapshotService: uses CDP Accessibility tree to build ARIA snapshots. */

import type { SnapshotService } from "../domain/browser.ts";
import { type AXNode, transformAXTree } from "./tree.ts";
import { renderYaml } from "./render.ts";

/** Dependencies for the snapshot service, provided by the CDP adapter. */
export interface SnapshotDeps {
  getFullAXTree(): Promise<AXNode[]>;
  resolveSelector(selector: string): Promise<number>;
}

/** Create a SnapshotService that transforms CDP Accessibility tree data. */
export function createSnapshotService(deps: SnapshotDeps): SnapshotService {
  return {
    async snapshot(options) {
      const axNodes = await deps.getFullAXTree();

      let rootNodeId: string | undefined;

      if (options.selector) {
        const backendNodeId = await deps.resolveSelector(options.selector);
        const match = axNodes.find((n) => n.backendDOMNodeId === backendNodeId);
        if (!match) return { yaml: "", refs: {} };
        rootNodeId = match.nodeId;
      }

      const { nodes, refs } = transformAXTree(axNodes, {
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes,
      }, rootNodeId);

      return { yaml: renderYaml(nodes), refs };
    },
  };
}
