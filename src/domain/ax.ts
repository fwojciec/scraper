/** Chrome CDP Accessibility tree types (subset of CDP Accessibility.AXNode). */

/** Chrome CDP AXValue. */
export interface AXValue {
  type: string;
  value?: string | number | boolean;
}

/** Chrome CDP AXNode from Accessibility.getFullAXTree(). */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}
