import { defineConfig } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      { root: "react", framework: "react", test: { name: "react", environment: "jsdom" } },
      { root: "vue", framework: "vue", test: { name: "vue", environment: "happy-dom" } },
    ],
  },
});
