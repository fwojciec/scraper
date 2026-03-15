/** How to address an element: by snapshot ref or CSS selector. */
export type ElementTarget =
  | { ref: string }
  | { selector: string };
