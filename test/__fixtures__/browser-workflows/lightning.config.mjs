export default {
  test: {
    include: ["*.spec.ts"],
    testTimeout: 5000,
    browser: { enabled: true, browsers: ["chromium"], headless: true },
    coverage: { include: ["value.ts"], reporter: ["json"] },
  },
};
