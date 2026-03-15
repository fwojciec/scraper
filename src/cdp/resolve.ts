import type { ElementTarget } from "../domain/element.ts";
import type { RefMap } from "../domain/snapshot.ts";
import type { CdpPageService } from "./connection.ts";

/**
 * Resolve an ElementTarget to a RemoteObjectId.
 * - ref: look up backendNodeId in refs, then DOM.resolveNode
 * - selector: querySelectorAll, error on 0 or >1 matches
 */
export async function resolveTarget(
  target: ElementTarget,
  page: CdpPageService,
  refs: RefMap | null,
): Promise<string> {
  if ("ref" in target) {
    if (!refs) {
      throw new Error(
        `no refs available — run 'scraper snapshot' first`,
      );
    }
    const backendNodeId = refs[target.ref];
    if (backendNodeId === undefined) {
      throw new Error(
        `unknown ref ${target.ref} — run 'scraper snapshot' to get current refs`,
      );
    }
    return await page.resolveRef(backendNodeId, target.ref);
  }

  return await page.resolveUniqueSelector(target.selector);
}
