import { describe, test, expect } from "bun:test";
import { createComposer } from "../public/ui/chat/composer.js";

type Listener = (event: unknown) => void;

function makeMockElement() {
  const listeners: Record<string, Listener[]> = {};
  return {
    value: "",
    style: {} as Record<string, string>,
    scrollHeight: 30,
    classList: {
      toggle(_name: string, _force?: boolean) {},
    },
    disabled: false,
    hidden: false,
    setAttribute(_name: string, _value: string) {},
    focus() {},
    addEventListener(type: string, fn: Listener) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    dispatchEvent(type: string, ev: unknown) {
      for (const fn of listeners[type] || []) {
        fn(ev);
      }
    },
  };
}

describe("createComposer - send, clearing, and pointer-aware enter", () => {
  test("send() clears the input value immediately and notifies onSend", () => {
    const input = makeMockElement();
    const sendButton = makeMockElement();
    const sent: string[] = [];

    const composer = createComposer({
      input: input as unknown as HTMLTextAreaElement,
      sendButton: sendButton as unknown as HTMLButtonElement,
      onSend: (text) => sent.push(text),
    });

    input.value = "Hello world";
    composer.send();

    expect(sent).toEqual(["Hello world"]);
    expect(input.value).toBe("");
  });

  test("send() is a no-op when text is only whitespace", () => {
    const input = makeMockElement();
    const sendButton = makeMockElement();
    const sent: string[] = [];

    const composer = createComposer({
      input: input as unknown as HTMLTextAreaElement,
      sendButton: sendButton as unknown as HTMLButtonElement,
      onSend: (text) => sent.push(text),
    });

    input.value = "   \n\t  ";
    composer.send();

    expect(sent).toEqual([]);
    expect(input.value).toBe("   \n\t  ");
  });

  test("on fine pointer (desktop), Enter sends and Shift+Enter inserts newline", () => {
    const input = makeMockElement();
    const sendButton = makeMockElement();
    const sent: string[] = [];

    createComposer({
      input: input as unknown as HTMLTextAreaElement,
      sendButton: sendButton as unknown as HTMLButtonElement,
      matchFinePointer: () => true,
      onSend: (text) => sent.push(text),
    });

    input.value = "Desktop line";

    // Shift+Enter should not send (default browser newline)
    let shiftPrevented = false;
    input.dispatchEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => { shiftPrevented = true; },
    });
    expect(shiftPrevented).toBe(false);
    expect(sent.length).toBe(0);
    expect(input.value).toBe("Desktop line");

    // Regular Enter should send and clear
    let enterPrevented = false;
    input.dispatchEvent("keydown", {
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => { enterPrevented = true; },
    });
    expect(enterPrevented).toBe(true);
    expect(sent).toEqual(["Desktop line"]);
    expect(input.value).toBe("");
  });

  test("on coarse pointer (mobile touch), Enter does not send to allow newlines, while Ctrl+Enter sends", () => {
    const input = makeMockElement();
    const sendButton = makeMockElement();
    const sent: string[] = [];

    createComposer({
      input: input as unknown as HTMLTextAreaElement,
      sendButton: sendButton as unknown as HTMLButtonElement,
      matchFinePointer: () => false, // mobile virtual keyboard
      onSend: (text) => sent.push(text),
    });

    input.value = "Paragraph one";

    // On mobile, pressing Enter on the virtual keyboard should not send
    let enterPrevented = false;
    input.dispatchEvent("keydown", {
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => { enterPrevented = true; },
    });
    expect(enterPrevented).toBe(false);
    expect(sent.length).toBe(0);
    expect(input.value).toBe("Paragraph one");

    // On mobile with physical keyboard shortcut or explicit modifier, Ctrl+Enter sends
    let ctrlEnterPrevented = false;
    input.dispatchEvent("keydown", {
      key: "Enter",
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => { ctrlEnterPrevented = true; },
    });
    expect(ctrlEnterPrevented).toBe(true);
    expect(sent).toEqual(["Paragraph one"]);
    expect(input.value).toBe("");
  });
});
