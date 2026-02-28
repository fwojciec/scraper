/** SnapshotService: evaluates page HTML via callback, parses with deno-dom, builds ARIA tree. */

import { DOMParser } from "@b-fuze/deno-dom";
import type { SnapshotService } from "../domain/browser.ts";
import { buildAriaTree, type DomElement } from "./tree.ts";
import { renderYaml } from "./render.ts";

/** Create a SnapshotService that fetches HTML via evaluateInPage and builds an ARIA tree. */
export function createSnapshotService(): SnapshotService {
  return {
    async snapshot(options, evaluateInPage) {
      const selector = options.selector ?? "body";
      const expression = `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? ""`;
      const html = await evaluateInPage(expression) as string;

      if (!html) return { yaml: "" };

      const doc = new DOMParser().parseFromString(html, "text/html");
      if (!doc) return { yaml: "" };

      const root = doc.body as unknown as DomElement;
      const nodes = buildAriaTree(root, {
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes,
      });

      return { yaml: renderYaml(nodes) };
    },
  };
}
