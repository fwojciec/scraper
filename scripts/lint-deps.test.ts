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
