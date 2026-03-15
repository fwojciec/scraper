/** CDP input actions: click, fill, type, select, submit, focus, pressKey, upload. */

// deno-lint-ignore no-explicit-any
export function createInputMethods(cdp: any, sessionId: string) {
  /** Focus the element. */
  async function focusElement(objectId: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: "function() { this.focus(); }",
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "focus failed";
      throw new Error(msg);
    }
  }

  /** Click element at the given RemoteObjectId using real pointer events. */
  async function clickElement(objectId: string): Promise<void> {
    // Ensure the element is visible in the viewport before computing coordinates
    await cdp.DOM.scrollIntoViewIfNeeded({ objectId }, sessionId);

    // Get the element's content quads (coordinates)
    const { quads } = await cdp.DOM.getContentQuads(
      { objectId },
      sessionId,
    );

    if (!quads || quads.length === 0) {
      throw new Error("element has no visible area — cannot click");
    }

    // Compute center of the first quad (array of 8 floats: x1,y1,x2,y2,x3,y3,x4,y4)
    const quad = quads[0];
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

    // Dispatch mouse events: move, press, release
    await cdp.Input.dispatchMouseEvent(
      { type: "mouseMoved", x, y },
      sessionId,
    );
    await cdp.Input.dispatchMouseEvent(
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      sessionId,
    );
    await cdp.Input.dispatchMouseEvent(
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      sessionId,
    );
  }

  /** Fill an input element: focus, clear, set value, dispatch input+change. */
  async function fillElement(objectId: string, value: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: `function(newValue) {
          if (!('value' in this)) throw new Error('element is not a fillable input');
          this.focus();
          this.value = '';
          this.value = newValue;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }],
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "fill failed";
      throw new Error(msg);
    }
  }

  /** Type text character by character: focus, then dispatch key events. */
  async function typeText(objectId: string, text: string): Promise<void> {
    await focusElement(objectId);

    // Type each character via key events
    for (const char of text) {
      await cdp.Input.dispatchKeyEvent(
        { type: "keyDown", key: char, text: char },
        sessionId,
      );
      await cdp.Input.dispatchKeyEvent(
        { type: "keyUp", key: char },
        sessionId,
      );
    }
  }

  /** Select a dropdown option: set value and dispatch input+change. */
  async function selectOption(objectId: string, value: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: `function(val) {
          if (this.tagName !== 'SELECT') throw new Error('element is not a <select>');
          const option = Array.from(this.options).find(o => o.value === val);
          if (!option) throw new Error('no option with value ' + JSON.stringify(val));
          this.value = val;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }],
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "select failed";
      throw new Error(msg);
    }
  }

  /** Submit the form containing the element (or the element itself if it's a form). */
  async function submitForm(objectId: string): Promise<void> {
    const result = await cdp.Runtime.callFunctionOn(
      {
        objectId,
        functionDeclaration: `function() {
          const form = this.tagName === 'FORM' ? this : this.closest('form');
          if (!form) throw new Error('no form found for this element');
          form.requestSubmit();
        }`,
        awaitPromise: false,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "submit failed";
      throw new Error(msg);
    }
  }

  /** Map logical key names to physical key codes for CDP Input.dispatchKeyEvent. */
  function keyToCode(k: string): string {
    const map: Record<string, string> = {
      Enter: "Enter",
      Tab: "Tab",
      Escape: "Escape",
      Space: "Space",
      Backspace: "Backspace",
      Delete: "Delete",
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Control: "ControlLeft",
      Shift: "ShiftLeft",
      Alt: "AltLeft",
      Meta: "MetaLeft",
    };
    if (map[k]) return map[k];
    if (k.length === 1) {
      const c = k.toLowerCase();
      if (c >= "a" && c <= "z") return `Key${c.toUpperCase()}`;
      if (c >= "0" && c <= "9") return `Digit${c}`;
    }
    return k;
  }

  /** Press a keyboard key (dispatched to the focused element). */
  async function pressKey(descriptor: string): Promise<void> {
    // Parse modifier prefixes (e.g., "Control+a", "Shift+Enter")
    // Use lastIndexOf to handle "+" as a key (e.g., "Shift++", "+")
    let modifiers: string[];
    let key: string;
    const lastPlus = descriptor.lastIndexOf("+");
    if (lastPlus === -1 || lastPlus === 0) {
      // No modifier separator, or descriptor is "+" itself
      modifiers = [];
      key = descriptor;
    } else if (lastPlus === descriptor.length - 1) {
      // Trailing "+": the key is "+", modifiers are everything before
      modifiers = descriptor.slice(0, lastPlus).split("+").filter((s) => s !== "");
      key = "+";
    } else {
      modifiers = descriptor.slice(0, lastPlus).split("+");
      key = descriptor.slice(lastPlus + 1);
    }

    // Map well-known key names to their text representation
    const textMap: Record<string, string> = {
      Enter: "\r",
      Space: " ",
      Tab: "\t",
    };
    const text = textMap[key];
    const code = keyToCode(key);

    // Press modifier keys
    for (const mod of modifiers) {
      await cdp.Input.dispatchKeyEvent(
        { type: "rawKeyDown", key: mod, code: keyToCode(mod) },
        sessionId,
      );
    }

    await cdp.Input.dispatchKeyEvent(
      { type: "rawKeyDown", key, code, ...(text ? { text } : {}) },
      sessionId,
    );
    if (text) {
      await cdp.Input.dispatchKeyEvent(
        { type: "char", key, code, text },
        sessionId,
      );
    }
    await cdp.Input.dispatchKeyEvent(
      { type: "keyUp", key, code },
      sessionId,
    );

    // Release modifier keys (reverse order)
    for (const mod of [...modifiers].reverse()) {
      await cdp.Input.dispatchKeyEvent(
        { type: "keyUp", key: mod, code: keyToCode(mod) },
        sessionId,
      );
    }
  }

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

  return {
    clickElement,
    fillElement,
    typeText,
    selectOption,
    submitForm,
    focusElement,
    pressKey,
    uploadFile,
  };
}
