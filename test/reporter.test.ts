import { expect, test } from "@lightning-js/lightning";
import { printSummary } from "../src/reporters/default.ts";
import { createRunSummary } from "../src/reporters/summary.ts";

test("prints Vitest-style phase timings in the duration summary", () => {
  const summary = createRunSummary(
    [{
      filepath: "/project/example.test.ts",
      results: [],
      durationMs: 2180,
      durationBreakdown: {
        transformMs: 564,
        setupMs: 0,
        importMs: 869,
        testsMs: 3400,
        environmentMs: 0,
      },
    }],
    2180,
  );
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));

  try {
    printSummary(summary);
  } finally {
    console.log = originalLog;
  }

  const plainOutput = output.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  expect(plainOutput).toContain(
    "Duration  2.18s (transform 564ms, setup 0ms, import 869ms, tests 3.40s, environment 0ms)",
  );
});
