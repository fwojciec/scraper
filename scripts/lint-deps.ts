/**
 * Dependency boundary enforcement using `deno info --json`.
 *
 * Rules:
 * - domain/ may import nothing from src/
 * - cdp/ may import only from domain/
 * - aria/ may import only from domain/
 * - http/ may import only from domain/
 * - cli/ may import only from domain/
 * - Only main.ts may import from all modules
 */

const SRC_MODULES = ["domain", "cdp", "aria", "http", "cli"] as const;

type Module = (typeof SRC_MODULES)[number];

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
  for (const mod of SRC_MODULES) {
    if (specifier.includes(`/src/${mod}/`)) return mod;
  }
  return null;
}

async function checkModule(mod: Module): Promise<string[]> {
  const entryPoint = `src/${mod}/mod.ts`;

  try {
    await Deno.stat(entryPoint);
  } catch {
    return [];
  }

  const cmd = new Deno.Command("deno", {
    args: ["info", "--json", entryPoint],
    stdout: "piped",
    stderr: "piped",
  });

  const { stdout, stderr, success } = await cmd.output();

  if (!success) {
    const err = new TextDecoder().decode(stderr);
    if (err.includes("Module not found") || err.includes("No modules")) return [];
    return [`Failed to analyze ${entryPoint}: ${err}`];
  }

  const info: DenoInfoOutput = JSON.parse(new TextDecoder().decode(stdout));
  const violations: string[] = [];
  const allowed = ALLOWED_IMPORTS[mod];

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

  return violations;
}

async function main(): Promise<void> {
  console.log("Checking dependency boundaries...\n");

  const allViolations: string[] = [];

  for (const mod of SRC_MODULES) {
    const violations = await checkModule(mod);
    if (violations.length > 0) {
      allViolations.push(...violations);
    } else {
      console.log(`  ✓ ${mod}/`);
    }
  }

  if (allViolations.length > 0) {
    console.error("\nDependency boundary violations:\n");
    for (const v of allViolations) {
      console.error(`  ✗ ${v}`);
    }
    Deno.exit(1);
  }

  console.log("\nAll dependency boundaries OK.");
}

main();
