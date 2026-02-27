/**
 * Dependency boundary enforcement.
 *
 * Scans ALL .ts files in each src/ module directory (not just mod.ts graph),
 * so stray files not re-exported from mod.ts are still checked.
 *
 * Rules:
 * - domain/ may import nothing from other src/ modules
 * - cdp/ may import only from domain/
 * - aria/ may import only from domain/
 * - http/ may import only from domain/
 * - cli/ may import only from domain/
 * - main.ts may import from all modules (composition root)
 * - No other file outside a module may import across module boundaries
 */

const ADAPTER_MODULES = ["cdp", "aria", "http", "cli"] as const;
const ALL_MODULES = ["domain", ...ADAPTER_MODULES] as const;

type Module = (typeof ALL_MODULES)[number];

const ALLOWED_IMPORTS: Record<Module, readonly Module[]> = {
  domain: [],
  cdp: ["domain"],
  aria: ["domain"],
  http: ["domain"],
  cli: ["domain"],
};

interface DenoInfoOutput {
  modules: Array<{
    specifier: string;
    dependencies?: Array<{
      specifier: string;
      code?: { specifier: string };
      type?: { specifier: string };
    }>;
  }>;
}

function getModule(specifier: string): Module | null {
  for (const mod of ALL_MODULES) {
    if (specifier.includes(`/src/${mod}/`)) return mod;
  }
  return null;
}

function isMainTs(specifier: string): boolean {
  return specifier.endsWith("/src/main.ts");
}

async function findTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(path);
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return files;
}

async function analyzeFile(filePath: string): Promise<DenoInfoOutput | null> {
  const cmd = new Deno.Command("deno", {
    args: ["info", "--json", filePath],
    stdout: "piped",
    stderr: "piped",
  });

  const { stdout, success } = await cmd.output();
  if (!success) return null;

  return JSON.parse(new TextDecoder().decode(stdout));
}

async function checkModule(mod: Module): Promise<string[]> {
  const dir = `src/${mod}`;
  const files = await findTsFiles(dir);
  if (files.length === 0) return [];

  const violations: string[] = [];
  const allowed = ALLOWED_IMPORTS[mod];

  for (const file of files) {
    const info = await analyzeFile(file);
    if (!info) continue;

    for (const module of info.modules) {
      const sourceModule = getModule(module.specifier);
      if (sourceModule !== mod) continue;

      for (const dep of module.dependencies ?? []) {
        const depSpec = dep.code?.specifier ?? dep.specifier;
        const depModule = getModule(depSpec);

        if (depModule === null) continue;
        if (depModule === mod) continue;
        if (allowed.includes(depModule)) continue;

        violations.push(
          `${mod}/ imports from ${depModule}/ (${module.specifier} -> ${depSpec}). ` +
            `Allowed: [${allowed.join(", ")}]`,
        );
      }
    }
  }

  return violations;
}

async function checkMainTs(): Promise<string[]> {
  const info = await analyzeFile("src/main.ts");
  if (!info) return [];

  const violations: string[] = [];

  // main.ts may import from any module — that's fine.
  // But check that no NON-main file in src/ root imports across boundaries.
  for (const module of info.modules) {
    if (isMainTs(module.specifier)) continue;
    if (getModule(module.specifier) !== null) continue;

    // This is a src/ root file that isn't main.ts and isn't in a module
    for (const dep of module.dependencies ?? []) {
      const depSpec = dep.code?.specifier ?? dep.specifier;
      const depModule = getModule(depSpec);
      if (depModule !== null) {
        violations.push(
          `Stray file imports from ${depModule}/ (${module.specifier} -> ${depSpec}). ` +
            `Only main.ts may import across modules.`,
        );
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  console.log("Checking dependency boundaries...\n");

  const allViolations: string[] = [];

  for (const mod of ALL_MODULES) {
    const violations = await checkModule(mod);
    if (violations.length > 0) {
      allViolations.push(...violations);
      for (const v of violations) {
        console.error(`  ✗ ${v}`);
      }
    } else {
      console.log(`  ✓ ${mod}/`);
    }
  }

  const mainViolations = await checkMainTs();
  if (mainViolations.length > 0) {
    allViolations.push(...mainViolations);
    for (const v of mainViolations) {
      console.error(`  ✗ ${v}`);
    }
  } else {
    console.log("  ✓ main.ts");
  }

  if (allViolations.length > 0) {
    console.error(`\n${allViolations.length} dependency boundary violation(s) found.`);
    Deno.exit(1);
  }

  console.log("\nAll dependency boundaries OK.");
}

main();
