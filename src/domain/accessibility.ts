/** Project-owned accessibility tree types. */

import type { DomNodeHandle } from "./snapshot.ts";

/** Value associated with an accessibility node property. */
export interface AccessibilityValue {
  type: string;
  value?: string | number | boolean;
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
