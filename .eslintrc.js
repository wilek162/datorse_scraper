"use strict";

module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,
  },
  parserOptions: {
    ecmaVersion: 2021,
  },
  rules: {
    // Code quality
    "no-unused-vars": [
      "warn",
      { args: "after-used", ignoreRestSiblings: true, argsIgnorePattern: "^_" },
    ],
    "no-undef": "error",
    "no-var": "error",
    "prefer-const": "warn",
    eqeqeq: ["error", "always"],

    // CJS / strict mode consistency — all files already have 'use strict'
    strict: ["error", "global"],

    // Async / error-handling
    "no-async-promise-executor": "error",
    "no-return-await": "warn",

    // Node.js best practices
    "no-process-exit": "off", // PM2 managed; explicit exits are intentional
    "no-console": "off", // Winston used; console allowed in CLI scripts
  },
};
