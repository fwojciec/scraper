/** Minimal DOM node interface compatible with both deno-dom and browser DOM. */
export interface DomNode {
  nodeType: number;
  textContent: string | null;
}

/** Minimal DOM element interface compatible with both deno-dom and browser DOM. */
export interface DomElement extends DomNode {
  tagName: string;
  childNodes: ArrayLike<DomNode> & Iterable<DomNode>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

/** ARIA node in the accessibility tree. */
export interface AriaNode {
  role: string;
  name?: string;
  level?: number;
  ref?: string;
  children?: AriaNode[];
}

export interface TreeOptions {
  maxDepth?: number;
  maxNodes?: number;
}

const HEADING_LEVEL: Record<string, number> = {
  H1: 1,
  H2: 2,
  H3: 3,
  H4: 4,
  H5: 5,
  H6: 6,
};

const INTERACTABLE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
]);

function getImplicitRole(el: DomElement): string | null {
  const tag = el.tagName;
  switch (tag) {
    case "A":
      return el.hasAttribute("href") ? "link" : null;
    case "BUTTON":
      return "button";
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "heading";
    case "TABLE":
      return "table";
    case "THEAD":
    case "TBODY":
    case "TFOOT":
      return "rowgroup";
    case "TR":
      return "row";
    case "TH":
      return "columnheader";
    case "TD":
      return "cell";
    case "IMG":
      return "img";
    case "INPUT": {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "hidden") return null;
      return "textbox";
    }
    case "SELECT":
      return "combobox";
    case "TEXTAREA":
      return "textbox";
    case "NAV":
      return "navigation";
    case "HEADER":
      return "banner";
    case "MAIN":
      return "main";
    case "FOOTER":
      return "contentinfo";
    case "ASIDE":
      return "complementary";
    case "SECTION":
      return el.hasAttribute("aria-label") ? "region" : null;
    case "FORM":
      return el.hasAttribute("aria-label") ? "form" : null;
    case "ARTICLE":
      return "article";
    case "UL":
    case "OL":
      return "list";
    case "LI":
      return "listitem";
    case "P":
      return "paragraph";
    default:
      return null;
  }
}

function isHidden(el: DomElement): boolean {
  const ariaHidden = el.getAttribute("aria-hidden");
  if (ariaHidden !== null && ariaHidden.toLowerCase() === "true") return true;
  if (el.hasAttribute("hidden")) return true;
  const style = el.getAttribute("style");
  if (style) {
    if (/display\s*:\s*none/i.test(style)) return true;
    if (/visibility\s*:\s*hidden/i.test(style)) return true;
  }
  return false;
}

function getTextContent(el: DomElement): string {
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      text += child.textContent ?? "";
    } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
      const childEl = child as DomElement;
      if (
        !isHidden(childEl) && getImplicitRole(childEl) === null && !childEl.getAttribute("role")
      ) {
        text += getTextContent(childEl);
      }
    }
  }
  return text;
}

function getAccessibleName(el: DomElement, role: string): string | undefined {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;
  if (role === "img") {
    return el.getAttribute("alt") || undefined;
  }
  return undefined;
}

interface BuildContext {
  refCounter: number;
  nodeCount: number;
  maxNodes: number;
}

function buildNode(
  el: DomElement,
  depth: number,
  maxDepth: number,
  ctx: BuildContext,
): AriaNode[] {
  if (ctx.nodeCount >= ctx.maxNodes) return [];
  if (isHidden(el)) return [];

  const explicitRole = el.getAttribute("role");
  const role = (explicitRole === "presentation" || explicitRole === "none")
    ? null
    : explicitRole || getImplicitRole(el);

  // Transparent/generic element — process children and return them directly
  if (!role) {
    return buildChildren(el, depth, maxDepth, ctx);
  }

  ctx.nodeCount++;

  const node: AriaNode = { role };

  // Heading level
  const level = HEADING_LEVEL[el.tagName];
  if (level) node.level = level;

  // Accessible name
  const name = getAccessibleName(el, role);
  if (name) node.name = name;

  // Ref for interactable elements
  if (INTERACTABLE_ROLES.has(role)) {
    ctx.refCounter++;
    node.ref = `e${ctx.refCounter}`;
  }

  // Process children if within depth limit
  if (depth < maxDepth) {
    const children = buildChildren(el, depth + 1, maxDepth, ctx);
    if (children.length > 0) {
      // If node has no explicit name and all children are text, concatenate as name
      if (!node.name) {
        const allText = children.every((c) => c.role === "text");
        if (allText) {
          const text = children.map((c) => c.name).join("").trim();
          if (text) node.name = text;
          // Don't add text children since we used them as name
        } else {
          node.children = children;
        }
      } else {
        // Name already set (e.g. aria-label) — keep only semantic children, drop text
        const semantic = children.filter((c) => c.role !== "text");
        if (semantic.length > 0) node.children = semantic;
      }
    } else if (!node.name) {
      // Leaf node with no name — compute from text content
      const text = getTextContent(el).trim();
      if (text) node.name = text;
    }
  } else if (!node.name) {
    const text = getTextContent(el).trim();
    if (text) node.name = text;
  }

  return [node];
}

function buildChildren(
  el: DomElement,
  depth: number,
  maxDepth: number,
  ctx: BuildContext,
): AriaNode[] {
  const results: AriaNode[] = [];
  for (const child of el.childNodes) {
    if (ctx.nodeCount >= ctx.maxNodes) break;
    if (child.nodeType === 3 /* TEXT_NODE */) {
      // Text nodes don't count toward maxNodes — they typically get absorbed
      // into parent names and don't add output lines.
      // Preserve raw text (normalize internal whitespace) so inter-node spaces
      // aren't lost when text is later concatenated for accessible names.
      const raw = child.textContent ?? "";
      if (raw.trim()) {
        results.push({ role: "text", name: raw.replace(/\s+/g, " ") });
      }
    } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
      results.push(...buildNode(child as DomElement, depth, maxDepth, ctx));
    }
  }
  return results;
}

/** Build an ARIA accessibility tree from a DOM element. */
export function buildAriaTree(root: DomElement, options?: TreeOptions): AriaNode[] {
  const ctx: BuildContext = {
    refCounter: 0,
    nodeCount: 0,
    maxNodes: options?.maxNodes ?? Infinity,
  };
  const maxDepth = options?.maxDepth ?? Infinity;
  return buildChildren(root, 0, maxDepth, ctx);
}
