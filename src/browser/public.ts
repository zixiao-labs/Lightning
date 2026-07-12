/**
 * Component-testing helpers (`@lightning-js/lightning/browser`).
 *
 * These are plain DOM utilities: they work in browser mode (real browsers) and
 * equally in the jsdom/happy-dom Node environments, so a component spec can run
 * in either. Events are real DOM events dispatched in-page (not CDP-trusted
 * input); Testing Library queries compose naturally with the returned
 * `container` since it's a real element in the live document.
 *
 * In browser mode the runner removes containers rendered during a test after
 * it ends (`cleanup()`); in Node environments call `cleanup()` yourself (e.g.
 * from `afterEach`) if a file renders more than once.
 */

function requireDocument(caller: string): Document {
  if (typeof document === "undefined") {
    throw new Error(
      `${caller} requires a DOM. Run in browser mode (test.browser.enabled / --browser) ` +
        "or a DOM environment (jsdom, happy-dom).",
    );
  }
  return document;
}

const containers = new Set<HTMLElement>();

export interface RenderResult {
  /** The wrapper element the markup/node was rendered into (attached to body). */
  container: HTMLElement;
  /** Remove the container from the document. */
  unmount(): void;
}

/**
 * Mount markup or a DOM node into a fresh container under `document.body`.
 * Strings are parsed as HTML (script tags do not execute — build real nodes
 * for behavior).
 */
export function render(input: string | Node): RenderResult {
  const doc = requireDocument("render()");
  const container = doc.createElement("div");
  container.setAttribute("data-lightning-container", "");
  if (typeof input === "string") container.innerHTML = input;
  else container.appendChild(input);
  doc.body.appendChild(container);
  containers.add(container);
  return {
    container,
    unmount() {
      containers.delete(container);
      container.remove();
    },
  };
}

/** Unmount every container created by {@link render}. */
export function cleanup(): void {
  for (const container of containers) container.remove();
  containers.clear();
}

function fire(target: EventTarget, event: Event): boolean {
  return target.dispatchEvent(event);
}

function mouse(type: string): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
}

function key(type: string, keyName: string): KeyboardEvent {
  return new KeyboardEvent(type, {
    key: keyName,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
}

type FillableElement = HTMLElement & { value: string };

function setValue(el: FillableElement, value: string): void {
  el.focus?.();
  el.value = value;
  fire(el, new Event("input", { bubbles: true }));
  fire(el, new Event("change", { bubbles: true }));
}

function clickElement(el: Element): void {
  if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
  else fire(el, mouse("click"));
}

/**
 * Real-DOM interaction helpers. Events are dispatched in-page: handlers, form
 * activation behavior (`HTMLElement.click`) and `input`/`change` semantics are
 * real, but the events are not OS/CDP-trusted (`:hover` styles won't apply).
 */
export const userEvent = {
  click(el: Element): void {
    clickElement(el);
  },

  dblClick(el: Element): void {
    clickElement(el);
    clickElement(el);
    fire(el, mouse("dblclick"));
  },

  hover(el: Element): void {
    fire(el, mouse("pointerover"));
    fire(el, mouse("mouseover"));
    fire(el, new MouseEvent("mouseenter", { bubbles: false, composed: true }));
  },

  unhover(el: Element): void {
    fire(el, mouse("pointerout"));
    fire(el, mouse("mouseout"));
    fire(el, new MouseEvent("mouseleave", { bubbles: false, composed: true }));
  },

  /** Replace the element's value in one step (fires `input` then `change`). */
  fill(el: Element, value: string): void {
    setValue(el as FillableElement, value);
  },

  /** Append text one character at a time with key events between `input`s. */
  type(el: Element, text: string): void {
    const target = el as FillableElement;
    target.focus?.();
    for (const ch of text) {
      fire(target, key("keydown", ch));
      fire(target, key("keypress", ch));
      target.value = (target.value ?? "") + ch;
      fire(target, new Event("input", { bubbles: true }));
      fire(target, key("keyup", ch));
    }
    fire(target, new Event("change", { bubbles: true }));
  },

  /** Press a single named key, e.g. `"Enter"` or `"Escape"`. */
  keyboard(el: Element, keyName: string): void {
    fire(el, key("keydown", keyName));
    fire(el, key("keyup", keyName));
  },

  selectOptions(el: Element, value: string): void {
    if (el.tagName.toLowerCase() !== "select") {
      throw new TypeError("selectOptions() requires a <select> element");
    }
    const select = el as HTMLSelectElement;
    if (![...select.options].some((option) => option.value === value)) {
      throw new Error(`selectOptions() could not find an option with value "${value}"`);
    }
    select.focus();
    select.value = value;
    fire(select, new Event("input", { bubbles: true }));
    fire(select, new Event("change", { bubbles: true }));
  },

  focus(el: Element): void {
    (el as HTMLElement).focus?.();
  },

  blur(el: Element): void {
    (el as HTMLElement).blur?.();
  },
};
