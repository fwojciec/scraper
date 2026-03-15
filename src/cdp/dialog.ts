/** CDP dialog handler: registers for Page.javascriptDialogOpening events. */

// deno-lint-ignore no-explicit-any
export function createDialogHandler(cdp: any, sessionId: string) {
  let dialogHandler:
    | ((type: string, message: string, defaultPrompt: string) => void)
    | null = null;

  // deno-lint-ignore no-explicit-any
  const listener = (e: any) => {
    if (e.sessionId === sessionId && dialogHandler) {
      dialogHandler(
        e.params.type,
        e.params.message,
        e.params.defaultPrompt ?? "",
      );
    }
  };

  cdp.Page.addEventListener("javascriptDialogOpening", listener);

  function onDialog(
    handler: (type: string, message: string, defaultPrompt: string) => void,
  ): () => void {
    if (dialogHandler) {
      throw new Error("dialog handler already registered — clean up the previous one first");
    }
    dialogHandler = handler;
    return () => {
      dialogHandler = null;
    };
  }

  async function handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await cdp.Page.handleJavaScriptDialog(
      { accept, ...(promptText !== undefined ? { promptText } : {}) },
      sessionId,
    );
  }

  function cleanup() {
    cdp.Page.removeEventListener("javascriptDialogOpening", listener);
    dialogHandler = null;
  }

  return { onDialog, handleDialog, cleanup };
}
