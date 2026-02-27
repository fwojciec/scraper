import { assertEquals } from "@std/assert";

Deno.test("lint:deps catches no violations on clean project", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-run", "--allow-read", "scripts/lint-deps.ts"],
    stdout: "piped",
    stderr: "piped",
  });
  const { success } = await cmd.output();
  assertEquals(success, true);
});

Deno.test("lint:deps catches cross-adapter violation", async () => {
  // Create a temporary file in aria/ that imports from cdp/
  const violatingFile = "src/aria/_violation_test.ts";
  await Deno.writeTextFile(violatingFile, 'import "../cdp/mod.ts";\n');

  try {
    const cmd = new Deno.Command("deno", {
      args: ["run", "--allow-run", "--allow-read", "scripts/lint-deps.ts"],
      stdout: "piped",
      stderr: "piped",
    });
    const { success, stderr } = await cmd.output();
    const errText = new TextDecoder().decode(stderr);

    assertEquals(success, false, "lint:deps should fail on cross-adapter import");
    assertEquals(
      errText.includes("aria/ imports from cdp/"),
      true,
      `Expected violation message, got: ${errText}`,
    );
  } finally {
    await Deno.remove(violatingFile);
  }
});
