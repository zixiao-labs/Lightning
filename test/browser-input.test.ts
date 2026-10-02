import { afterEach, expect, test } from "@lightning-js/lightning";
import { userEvent } from "../src/browser/public.ts";

type BridgeGlobal = typeof globalThis & {
  __lightning_input__?: (action: { method: string; selector: string; value?: string }) => Promise<void>;
};
const globals = globalThis as BridgeGlobal;

afterEach(() => { delete globals.__lightning_input__; });

test("DOM fallback remains usable without a browser input bridge", async () => {
  let clicks = 0;
  const element = { click() { clicks++; } } as unknown as Element;
  const { click } = userEvent;
  await click(element);
  expect(clicks).toBe(1);
});

test("browser actions await the bridge and always remove temporary target attributes", async () => {
  const attributes = new Map<string, string>();
  const element = {
    isConnected: true,
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    removeAttribute(name: string) { attributes.delete(name); },
  } as unknown as Element;
  let release!: () => void;
  globals.__lightning_input__ = async ({ method, selector, value }) => {
    expect(method).toBe("fill");
    expect(value).toBe("hello");
    expect(selector).toContain("data-lightning-action-");
    expect(attributes.size).toBe(1);
    await new Promise<void>((resolve) => { release = resolve; });
  };
  const pending = userEvent.fill(element, "hello");
  expect(attributes.size).toBe(1);
  release();
  await pending;
  expect(attributes.size).toBe(0);
  globals.__lightning_input__ = async () => { throw new Error("action failed"); };
  await expect(userEvent.click(element)).rejects.toThrow("action failed");
  expect(attributes.size).toBe(0);
});

test("browser actions reject detached targets rather than silently dispatching untrusted input", async () => {
  let called = false;
  globals.__lightning_input__ = async () => { called = true; };
  await expect(userEvent.click({ isConnected: false } as Element)).rejects.toThrow("attached");
  expect(called).toBe(false);
});
