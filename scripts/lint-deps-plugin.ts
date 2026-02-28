const ADAPTER_MODULES = ["cdp", "aria", "http", "cli", "fs"] as const;
const ALL_MODULES = ["domain", ...ADAPTER_MODULES] as const;

type Module = (typeof ALL_MODULES)[number];

const ALLOWED_IMPORTS: Record<Module, readonly Module[]> = {
  domain: [],
  cdp: ["domain"],
  aria: ["domain"],
  http: ["domain"],
  cli: ["domain"],
  fs: ["domain"],
};

type SourceKind =
  | { type: "module"; module: Module }
  | { type: "main" }
  | { type: "stray" }
  | { type: "outside" };

function classifySource(filePath: string): SourceKind {
  const modMatch = filePath.match(/src\/([^/]+)\//);
  if (modMatch) {
    const mod = modMatch[1];
    if (ALL_MODULES.includes(mod as Module)) return { type: "module", module: mod as Module };
    return { type: "stray" };
  }
  if (/src\/main\.ts$/.test(filePath)) return { type: "main" };
  if (/src\/[^/]+\.ts$/.test(filePath)) return { type: "stray" };
  return { type: "outside" };
}

function resolveImport(sourceFile: string, importPath: string): string {
  const sourceDir = sourceFile.replace(/[^/]+$/, "");
  const parts = (sourceDir + importPath).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  return resolved.join("/");
}

function getModuleFromResolved(resolvedPath: string): Module | null {
  const match = resolvedPath.match(/(?:^|\/)src\/([^/]+)\//);
  if (match && ALL_MODULES.includes(match[1] as Module)) return match[1] as Module;
  return null;
}

function extractImportPath(specifier: string): { path: string; isRelative: boolean } | null {
  if (specifier.startsWith(".")) return { path: specifier, isRelative: true };
  // file:// URLs that point into src/
  if (specifier.startsWith("file://")) {
    try {
      const path = new URL(specifier).pathname;
      if (path.includes("/src/")) return { path, isRelative: false };
    } catch { /* malformed URL */ }
  }
  return null;
}

function checkImportPath(
  context: Deno.lint.RuleContext,
  // deno-lint-ignore no-explicit-any
  node: any,
  importPath: string,
  source: SourceKind,
): void {
  const extracted = extractImportPath(importPath);
  if (!extracted) return;

  const resolved = extracted.isRelative
    ? resolveImport(context.filename, extracted.path)
    : extracted.path;
  const target = getModuleFromResolved(resolved);
  if (target === null) return;

  if (source.type === "module") {
    if (target === source.module) return;
    const allowed = ALLOWED_IMPORTS[source.module];
    if (allowed.includes(target)) return;
    context.report({
      node,
      message: `${source.module}/ cannot import from ${target}/ (allowed: [${allowed.join(", ")}])`,
    });
  } else if (source.type === "stray") {
    context.report({
      node,
      message: `stray src/ file cannot import from ${target}/ (only main.ts may import modules)`,
    });
  }
}

const plugin: Deno.lint.Plugin = {
  name: "scraper",
  rules: {
    "dependency-boundary": {
      create(context) {
        const source = classifySource(context.filename);
        if (source.type === "outside" || source.type === "main") return {};

        // deno-lint-ignore no-explicit-any
        function getSpecifier(node: any): string | undefined {
          const src = node.source;
          if (!src) return undefined;
          // String literal: source.value is the string
          if (typeof src.value === "string") return src.value;
          // Template literal with no expressions: quasis[0].cooked
          if (src.type === "TemplateLiteral" && src.expressions?.length === 0) {
            return src.quasis?.[0]?.cooked as string | undefined;
          }
          return undefined;
        }

        // deno-lint-ignore no-explicit-any
        function checkNode(node: any): void {
          const importPath = getSpecifier(node);
          if (importPath) checkImportPath(context, node, importPath, source);
        }

        return {
          ImportDeclaration: checkNode,
          ExportAllDeclaration: checkNode,
          ExportNamedDeclaration: checkNode,
          ImportExpression: checkNode,
        };
      },
    },
  },
};

export default plugin;
