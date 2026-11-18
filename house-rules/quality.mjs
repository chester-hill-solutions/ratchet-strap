/**
 * Starter quality policy. Copy this file into your repository's `house-rules/`
 * directory and change the thresholds to match your project. RatchetStrap
 * itself ships no thresholds.
 */
export const qualityPolicy = {
  id: "quality@1",
  rules: {
    complexity: ["warn", { max: 20 }],
    "max-depth": ["warn", { max: 4 }],
    "max-params": ["warn", { max: 5 }],
    "max-lines-per-function": [
      "warn",
      { max: 200, skipBlankLines: true, skipComments: true },
    ],
    "no-console": "warn",
    "no-return-await": "warn",
    "@typescript-eslint/no-non-null-assertion": "warn",
  },
};
