import { assertEquals } from "@std/assert";
import { createJsonFileStore } from "./mod.ts";

Deno.test("JsonFileStore", async (t) => {
  const tmpDir = await Deno.makeTempDir();
  const path = `${tmpDir}/test.json`;

  interface TestData {
    name: string;
    value: number;
  }

  const store = createJsonFileStore<TestData>(path);

  await t.step("read returns null for missing file", async () => {
    const result = await store.read();
    assertEquals(result, null);
  });

  await t.step("write then read round-trips data", async () => {
    const data: TestData = { name: "hello", value: 42 };
    await store.write(data);
    const result = await store.read();
    assertEquals(result, data);
  });

  await t.step("remove deletes the file", async () => {
    await store.remove();
    const result = await store.read();
    assertEquals(result, null);
  });

  await t.step("remove on missing file is a no-op", async () => {
    await store.remove(); // should not throw
  });

  await t.step("read returns null for malformed JSON", async () => {
    await Deno.writeTextFile(path, "not valid json {{{");
    const result = await store.read();
    assertEquals(result, null);
  });

  await t.step("write creates parent directories", async () => {
    const nested = `${tmpDir}/a/b/c/nested.json`;
    const nestedStore = createJsonFileStore<TestData>(nested);
    const data: TestData = { name: "nested", value: 99 };
    await nestedStore.write(data);
    const result = await nestedStore.read();
    assertEquals(result, data);
  });

  await t.step("write produces valid JSON file", async () => {
    const atomicPath = `${tmpDir}/atomic.json`;
    const atomicStore = createJsonFileStore<TestData>(atomicPath);
    const data: TestData = { name: "atomic", value: 123 };
    await atomicStore.write(data);
    const raw = await Deno.readTextFile(atomicPath);
    assertEquals(JSON.parse(raw), data);
  });

  // Cleanup
  await Deno.remove(tmpDir, { recursive: true });
});
