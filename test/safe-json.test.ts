import assert from "node:assert/strict";
import { test } from "node:test";

import { safeJsonStringify } from "./support/safe-json.js";

test("test HTTP fixtures omit stack traces from serialized responses", () => {
  const error = new Error("fixture failure");
  const parsed = JSON.parse(
    safeJsonStringify({
      error,
      nested: { name: "Error", message: "nested failure", stack: "/private/secret.ts:1" },
    }),
  );

  assert.deepEqual(parsed, {
    error: { name: "Error", message: "fixture failure" },
    nested: { name: "Error", message: "nested failure" },
  });
  assert.equal(JSON.stringify(parsed).includes("/private/secret.ts"), false);
});
