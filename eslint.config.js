export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        Blob: "readonly",
        DecompressionStream: "readonly",
        DOMException: "readonly",
        File: "readonly",
        IDBKeyRange: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
        console: "readonly",
        crypto: "readonly",
        devicePixelRatio: "readonly",
        document: "readonly",
        fetch: "readonly",
        getComputedStyle: "readonly",
        history: "readonly",
        indexedDB: "readonly",
        location: "readonly",
        matchMedia: "readonly",
        performance: "readonly",
        scheduler: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "no-constant-condition": "error"
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { crypto: "readonly", performance: "readonly" },
    },
    rules: { "no-undef": "error", "no-unused-vars": "error" },
  },
];

