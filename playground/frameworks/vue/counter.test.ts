import { createApp, h, nextTick, ref } from "vue";
import { test, expect } from "@lightning-js/lightning";
import { userEvent } from "@lightning-js/lightning/browser";

test("Vue component updates in happy-dom", async ({ onTestFinished }) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp({
    setup() {
      const count = ref(0);
      return () => h("button", { onClick: () => count.value++ }, String(count.value));
    },
  });
  onTestFinished(() => { app.unmount(); container.remove(); });
  app.mount(container);
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("0");
  await userEvent.click(button);
  await nextTick();
  expect(button.textContent).toBe("1");
});
