import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, next],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "**/src/generated/**",
    "**/src/env.ts",
    // Vendored shadcn registry components (shadcn, coss, Magic UI, Dice UI); keep upstream-diffable.
    "apps/site/components/ui/**",
    "apps/site/hooks/**",
    "apps/site/lib/compose-refs.ts",
  ],
  // Preserve the generators' named functions alongside arrow components.
  rules: {
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    "react/function-component-definition": [
      "error",
      { namedComponents: ["function-declaration", "arrow-function"] },
    ],
  },
});
