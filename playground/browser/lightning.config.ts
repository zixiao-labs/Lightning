import { defineConfig } from "@lightning-js/lightning";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    browser: {
      enabled: true,
      provider: "playwright",
      browsers: ["chromium"],
      headless: true,
    },
  },
});
