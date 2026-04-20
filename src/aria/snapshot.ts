/** SnapshotService: uses CDP Accessibility tree to build ARIA snapshots. */

import type { SnapshotService } from "../domain/browser.ts";
import { type AccessibilityNode, transformAXTree } from "./tree.ts";
import { renderYaml } from "./render.ts";

/** Dependencies for the snapshot service, provided by the CDP adapter. */
export interface SnapshotDeps {
  getFullAXTree(): Promise<AccessibilityNode[]>;
  resolveSelector(selector: string): Promise<number>;
}

/** Create a SnapshotService that transforms CDP Accessibility tree data. */
export function createSnapshotService(deps: SnapshotDeps): SnapshotService {
  return {
    async snapshot(options) {
      const startingRefCounter = options.startingRefCounter ?? 0;
      const axNodes = await deps.getFullAXTree();

      let rootNodeId: string | undefined;

      if (options.selector) {
        const backendNodeId = await deps.resolveSelector(options.selector);
        const match = axNodes.find((n) => n.backendDOMNodeId === backendNodeId);
        if (!match) return { yaml: "", refs: {}, lastRefCounter: startingRefCounter };
        rootNodeId = match.nodeId;
      }

      const { nodes, refs, lastRefCounter } = transformAXTree(axNodes, {
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes,
        startRefCounter: startingRefCounter,
      }, rootNodeId);

      return { yaml: renderYaml(nodes), refs, lastRefCounter };
    },
  };
}
