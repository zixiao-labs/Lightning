/**
 * Playwright loader for browser mode.
 *
 * Playwright is an optional peer: try importing `playwright` (full package)
 * then `playwright-core` (BYO browsers), first from Lightning's own resolution
 * scope and then from the user's project root — pnpm's strict layout means an
 * undeclared dependency of Lightning wouldn't otherwise be visible here.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserName } from "../types.ts";

export interface BrowserAction {
  method: string;
  selector: string;
  value?: string;
}

export interface PlaywrightLocator {
  click(): Promise<void>;
  dblclick(): Promise<void>;
  hover(): Promise<void>;
  fill(value: string): Promise<void>;
  pressSequentially(value: string): Promise<void>;
  press(value: string): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  focus(): Promise<void>;
  evaluate(fn: (el: HTMLElement) => void): Promise<void>;
}

/** Structural slice of Playwright's API — enough to launch and drive pages. */
export interface PlaywrightPage {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  exposeBinding(name: string, callback: (source: unknown, action: BrowserAction) => Promise<void>): Promise<void>;
  locator(selector: string): PlaywrightLocator;
  mouse: { move(x: number, y: number): Promise<void> };
  coverage: {
    startJSCoverage(options: { resetOnNavigation: boolean }): Promise<void>;
    stopJSCoverage(): Promise<Array<{
      url: string;
      source?: string;
      functions: import("../types.ts").V8CoverageFunction[];
    }>>;
  };
  on(event: "console", listener: (message: PlaywrightConsoleMessage) => void): void;
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "crash", listener: () => void): void;
  on(event: "close", listener: () => void): void;
}

export interface PlaywrightConsoleMessage {
  type(): string;
  text(): string;
}

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserType {
  launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
}

export type PlaywrightModule = Record<BrowserName, PlaywrightBrowserType>;

const PLAYWRIGHT_PACKAGES = ["playwright", "playwright-core"];

export async function loadPlaywrightModule(root: string): Promise<PlaywrightModule> {
  const failures: string[] = [];

  for (const pkg of PLAYWRIGHT_PACKAGES) {
    try {
      return (await import(pkg)) as PlaywrightModule;
    } catch (error) {
      failures.push(`${pkg}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Resolve from the project under test (covers pnpm strict layouts where the
  // user's playwright isn't visible from Lightning's own package scope).
  const require = createRequire(path.join(root, "package.json"));
  for (const pkg of PLAYWRIGHT_PACKAGES) {
    try {
      const resolved = require.resolve(pkg);
      return (await import(pathToFileURL(resolved).href)) as PlaywrightModule;
    } catch (error) {
      failures.push(`${pkg} (from ${root}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    "Browser mode requires Playwright, which is an optional peer dependency.\n" +
      "Install it in your project:\n" +
      "  pnpm add -D playwright\n" +
      "  npx playwright install chromium\n" +
      "(playwright-core also works when browsers are already installed.)\n\n" +
      `Resolution attempts:\n  ${failures.join("\n  ")}`,
  );
}
