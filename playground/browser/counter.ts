import "./counter.css";

/**
 * A vanilla DOM counter component — enough behavior (event listeners, state,
 * conditional class, form input) to prove real-browser interaction in tests.
 */
export function createCounter(initial = 0): HTMLElement {
  let count = initial;

  const root = document.createElement("div");
  root.className = "counter";

  const label = document.createElement("output");
  label.setAttribute("data-testid", "count");

  const increment = document.createElement("button");
  increment.setAttribute("data-testid", "increment");
  increment.type = "button";
  increment.textContent = "+1";

  const reset = document.createElement("button");
  reset.setAttribute("data-testid", "reset");
  reset.type = "button";
  reset.textContent = "reset";

  const input = document.createElement("input");
  input.setAttribute("data-testid", "step-input");
  input.type = "text";
  input.value = "1";

  function renderCount(): void {
    label.textContent = String(count);
    root.classList.toggle("is-positive", count > 0);
  }

  increment.addEventListener("click", () => {
    const step = Number.parseInt(input.value, 10);
    count += Number.isNaN(step) ? 1 : step;
    renderCount();
  });
  reset.addEventListener("click", () => {
    count = initial;
    renderCount();
  });

  renderCount();
  root.append(label, increment, reset, input);
  return root;
}
