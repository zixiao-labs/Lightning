import { defineConfig } from "@lightning-js/lightning";

export default defineConfig({
  test: {
    // Defaults already discover **/*.{test,spec}.*; shown here for documentation.
    include: ["**/*.{test,spec}.{ts,tsx,js}"],
  },
});
