/** Project-owned accessibility tree types. */

import type { DomNodeHandle } from "./snapshot.ts";

/** A single AXValue source entry preserved from CDP — only the fields we need. */
export interface AccessibilityValueSource {
  type: string;
  superseded?: boolean;
  invalid?: boolean;
  /**
   * True when the raw CDP source had a `value` field set — i.e., this source
   * actually contributed to the computed name. Sources without a value are
   * "placeholder" entries listing where CDP looked.
   */
  contributed?: boolean;
}

/** Value associated with an accessibility node property. */
export interface AccessibilityValue {
  type: string;
  value?: string | number | boolean;
  /**
   * Raw CDP AXValue sources (e.g. `attribute`, `contents`, `relatedElement`).
   * Preserved because CDP exposes the name *source* here, not in `type`
   * (which is an AXValueType — typically `computedString`).
   */
  sources?: AccessibilityValueSource[];
}

/** Node in the accessibility tree. */
export interface AccessibilityNode {
  nodeId: string;
  ignored?: boolean;
  role?: AccessibilityValue;
  name?: AccessibilityValue;
  properties?: Array<{ name: string; value: AccessibilityValue }>;
  childIds?: string[];
  backendDOMNodeId?: DomNodeHandle;
  parentId?: string;
}
