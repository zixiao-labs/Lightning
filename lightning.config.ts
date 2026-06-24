export default {
  test: {
    include: ["test/**/*.test.ts"],
    pool: "threads",
    poolOptions: {
      maxWorkers: 2,
    },
    testTimeout: 2000,
  },
} satisfies import("./src/index.ts").LightningConfig;
