import { describe, expect, test } from "@lightning-js/lightning";
import { render, userEvent } from "@lightning-js/lightning/browser";
import { createCounter } from "./counter.ts";

describe("counter component", () => {
  test("runs in a real browser DOM", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
    // Real Chromium, not an emulated DOM.
    expect(navigator.userAgent).toContain("Chrome");
  });

  test("increments on real click events", () => {
    const { container } = render(createCounter());
    const count = container.querySelector("[data-testid=count]")!;
    const increment =
      container.querySelector<HTMLButtonElement>("[data-testid=increment]")!;

    expect(count.textContent).toBe("0");
    userEvent.click(increment);
    userEvent.click(increment);
    expect(count.textContent).toBe("2");
  });

  test("reads the step from a real input element", () => {
    const { container } = render(createCounter());
    const count = container.querySelector("[data-testid=count]")!;
    const increment =
      container.querySelector<HTMLButtonElement>("[data-testid=increment]")!;
    const step = container.querySelector<HTMLInputElement>("[data-testid=step-input]")!;

    userEvent.fill(step, "10");
    expect(step.value).toBe("10");
    userEvent.click(increment);
    expect(count.textContent).toBe("10");
  });

  test("resets state and reflects it in class + computed style", () => {
    const { container } = render(createCounter());
    const root = container.querySelector<HTMLElement>(".counter")!;
    const increment =
      container.querySelector<HTMLButtonElement>("[data-testid=increment]")!;
    const reset = container.querySelector<HTMLButtonElement>("[data-testid=reset]")!;

    // Imported CSS is injected by the dev pipeline; getComputedStyle proves the
    // stylesheet is live in the page, not just the class flag.
    expect(getComputedStyle(root).color).toBe("rgb(20, 20, 20)");
    userEvent.click(increment);
    expect(root.classList.contains("is-positive")).toBe(true);
    expect(getComputedStyle(root).color).toBe("rgb(0, 128, 0)");

    userEvent.click(reset);
    expect(root.classList.contains("is-positive")).toBe(false);
    expect(getComputedStyle(root).color).toBe("rgb(20, 20, 20)");
  });

  test("containers are cleaned up between tests", () => {
    // The previous tests' containers were removed by the per-test cleanup.
    expect(document.querySelectorAll("[data-lightning-container]").length).toBe(0);
  });

  test("markup matches its snapshot", () => {
    const { container } = render(createCounter());
    expect(container.querySelector(".counter")!.outerHTML).toMatchSnapshot();
  });
});
