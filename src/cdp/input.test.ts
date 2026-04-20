import { assertEquals, assertRejects } from "@std/assert";
import { createInputMethods } from "./input.ts";

const SID = "s1";

interface SetFileCall {
  files: string[];
  backendNodeId: number;
}

/** Stub CDP for upload tests. */
function stubCdp(opts: {
  isFileInput?: boolean;
  checkException?: boolean;
} = {}) {
  const { isFileInput = true, checkException = false } = opts;
  const setFileCalls: SetFileCall[] = [];
  const cdp = {
    Runtime: {
      callFunctionOn() {
        if (checkException) {
          return Promise.resolve({
            exceptionDetails: { exception: { description: "boom" } },
          });
        }
        return Promise.resolve({ result: { value: isFileInput } });
      },
    },
    DOM: {
      describeNode() {
        return Promise.resolve({ node: { backendNodeId: 42 } });
      },
      setFileInputFiles(params: SetFileCall) {
        setFileCalls.push(params);
        return Promise.resolve();
      },
    },
  };
  return { cdp, setFileCalls };
}

Deno.test("uploadFile: sets files via DOM.setFileInputFiles for file input", async () => {
  const { cdp, setFileCalls } = stubCdp({ isFileInput: true });
  const input = createInputMethods(cdp, SID);
  await input.uploadFile("obj-1", "/tmp/photo.jpg");
  assertEquals(setFileCalls.length, 1);
  assertEquals(setFileCalls[0].files, ["/tmp/photo.jpg"]);
  assertEquals(setFileCalls[0].backendNodeId, 42);
});

Deno.test("uploadFile: rejects when element is not a file input", async () => {
  const { cdp, setFileCalls } = stubCdp({ isFileInput: false });
  const input = createInputMethods(cdp, SID);
  await assertRejects(
    () => input.uploadFile("obj-1", "/tmp/photo.jpg"),
    Error,
    "not a file input",
  );
  assertEquals(setFileCalls.length, 0);
});

Deno.test("uploadFile: surfaces check exception", async () => {
  const { cdp } = stubCdp({ checkException: true });
  const input = createInputMethods(cdp, SID);
  await assertRejects(
    () => input.uploadFile("obj-1", "/tmp/photo.jpg"),
    Error,
    "boom",
  );
});
