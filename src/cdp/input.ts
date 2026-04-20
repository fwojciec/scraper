/** CDP input actions: file upload only. */

// deno-lint-ignore no-explicit-any
export function createInputMethods(cdp: any, sessionId: string) {
  /** Upload a file to an input[type=file] element. */
  async function uploadFile(objectId: string, filePath: string): Promise<void> {
    // Verify it's a file input
    const checkResult = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration:
          "function() { return this.tagName === 'INPUT' && this.type === 'file'; }",
        returnByValue: true,
      },
      sessionId,
    );
    if (checkResult.exceptionDetails) {
      const msg = checkResult.exceptionDetails.exception?.description ??
        checkResult.exceptionDetails.text ?? "check failed";
      throw new Error(msg);
    }
    if (!checkResult.result.value) {
      throw new Error("element is not a file input");
    }

    // Get backendNodeId
    const desc = await cdp.DOM.describeNode({ objectId }, sessionId);
    const backendNodeId = desc.node.backendNodeId;

    // Set the file
    await cdp.DOM.setFileInputFiles(
      { files: [filePath], backendNodeId },
      sessionId,
    );
  }

  return { uploadFile };
}
