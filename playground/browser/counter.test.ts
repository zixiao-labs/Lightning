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

  test("increments on real click events", async () => {
    const { container } = render(createCounter());
    const count = container.querySelector("[data-testid=count]")!;
    const increment =
      container.querySelector<HTMLButtonElement>("[data-testid=increment]")!;

    expect(count.textContent).toBe("0");
    await userEvent.click(increment);
    await userEvent.click(increment);
    expect(count.textContent).toBe("2");
  });

  test("reads the step from a real input element", async () => {
    const { container } = render(createCounter());
    const count = container.querySelector("[data-testid=count]")!;
    const increment =
      container.querySelector<HTMLButtonElement>("[data-testid=increment]")!;
    const step = container.querySelector<HTMLInputElement>("[data-testid=step-input]")!;

    await userEvent.fill(step, "10");
    expect(step.value).toBe("10");
    await userEvent.click(increment);
    expect(count.textContent).toBe("10");

    await userEvent.fill(step, "0");
    await userEvent.click(increment);
    expect(count.textContent).toBe("10");
  });

  test("selects existing options and supports destructured double-click", async () => {
    const select = document.createElement("select");
    select.innerHTML = '<option value="one">one</option><option value="two">two</option>';
    render(select);
    const events: string[] = [];
    select.addEventListener("input", () => events.push("input"));
    select.addEventListener("change", () => events.push("change"));

    await userEvent.selectOptions(select, "two");
    expect(select.value).toBe("two");
    expect(events).toEqual(["input", "change"]);
    await expect(userEvent.selectOptions(select, "missing")).rejects.toThrow("could not find");
    await expect(userEvent.selectOptions(document.createElement("input"), "two")).rejects.toThrow(
      "requires a <select>",
    );

    const button = document.createElement("button");
    button.textContent = "Double click";
    render(button);
    let clicks = 0;
    let doubleClicks = 0;
    button.addEventListener("click", () => clicks++);
    button.addEventListener("dblclick", () => doubleClicks++);
    const { dblClick } = userEvent;
    await dblClick(button);
    expect(clicks).toBe(2);
    expect(doubleClicks).toBe(1);
  });

  test("resets state and reflects it in class + computed style", async () => {
    const { container } = render(createCounter());
    const root = container.querySelector<HTMLElement>(".counter")!;
    const increment =
      container.querySelector<HTMLButtonElement>("[data-testid=increment]")!;
    const reset = container.querySelector<HTMLButtonElement>("[data-testid=reset]")!;

    // Imported CSS is injected by the dev pipeline; getComputedStyle proves the
    // stylesheet is live in the page, not just the class flag.
    expect(getComputedStyle(root).color).toBe("rgb(20, 20, 20)");
    await userEvent.click(increment);
    expect(root.classList.contains("is-positive")).toBe(true);
    expect(getComputedStyle(root).color).toBe("rgb(0, 128, 0)");

    await userEvent.click(reset);
    expect(root.classList.contains("is-positive")).toBe(false);
    expect(getComputedStyle(root).color).toBe("rgb(20, 20, 20)");
  });

  test("trusted input activates :hover and native click handlers", async () => {
    const { container } = render('<style>.trusted-button { color: rgb(1, 2, 3) } .trusted-button:hover { color: rgb(4, 5, 6) }</style><button class="trusted-button">Trusted</button>');
    const button = container.querySelector<HTMLButtonElement>("button")!;
    let trusted = false;
    button.addEventListener("click", (event) => { trusted = event.isTrusted; });
    await userEvent.hover(button);
    expect(button.matches(":hover")).toBe(true);
    expect(getComputedStyle(button).color).toBe("rgb(4, 5, 6)");
    await userEvent.click(button);
    expect(trusted).toBe(true);
    await userEvent.unhover(button);
    expect(button.matches(":hover")).toBe(false);
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
