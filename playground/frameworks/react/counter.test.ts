import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { test, expect, vi } from "@lightning-js/lightning";
import { userEvent } from "@lightning-js/lightning/browser";

function Counter() {
  const [count, setCount] = useState(0);
  return createElement("button", { onClick: () => setCount((value) => value + 1) }, String(count));
}

test("React component updates in jsdom", async ({ onTestFinished }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(createElement(Counter)));
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("0");
  await act(async () => { await userEvent.click(button); });
  expect(button.textContent).toBe("1");
});
