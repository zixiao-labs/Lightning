import { expect, test } from "@lightning-js/lightning";

test("matches a stored file snapshot", () => {
  expect({ framework: "lightning", phases: [1, 2], ready: true }).toMatchSnapshot();
});
