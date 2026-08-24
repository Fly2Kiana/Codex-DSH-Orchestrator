import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelRoutingError, resolveModelSelection, type ModelProfile } from "../src/model-routing.js";
import type { DshSessionModels } from "../src/dsh-types.js";

function catalog(): DshSessionModels {
  return {
    current: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" },
    routable: true,
    groups: [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          {
            id: "deepseek-v4-flash",
            name: "Flash",
            reasoning: {
              efforts: [
                { id: "low", name: "Low" },
                { id: "high", name: "High" },
              ],
              defaultEffort: "high",
            },
          },
          {
            id: "deepseek-v4-pro",
            name: "Pro",
            reasoning: {
              efforts: [
                { id: "medium", name: "Medium" },
                { id: "high", name: "High" },
              ],
              defaultEffort: "medium",
            },
          },
        ],
      },
      {
        id: "deepseek-modlens",
        name: "DeepSeek ModLens",
        models: [
          { id: "deepseek-v4-flash", name: "Flash (modlens vision)" },
          {
            id: "deepseek-v4-pro",
            name: "Pro (modlens vision)",
            reasoning: {
              efforts: [{ id: "high", name: "High" }],
              defaultEffort: "high",
            },
          },
        ],
      },
    ],
    failures: [],
  };
}

test("maps every semantic profile to an exact catalog route", () => {
  const expected: Record<Exclude<ModelProfile, "inherit">, { provider: string; model: string }> = {
    flash: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    pro: { provider: "deepseek-official", model: "deepseek-v4-pro" },
    "modlens-flash": { provider: "deepseek-modlens", model: "deepseek-v4-flash" },
    "modlens-pro": { provider: "deepseek-modlens", model: "deepseek-v4-pro" },
  };

  for (const [profile, route] of Object.entries(expected)) {
    const selected = resolveModelSelection(catalog(), profile as Exclude<ModelProfile, "inherit">);
    assert.deepEqual(
      { provider: selected.provider, model: selected.model },
      route,
      `wrong route for ${profile}`,
    );
  }
});

test("inherit keeps the current route and an explicit effort overrides the catalog default", () => {
  assert.deepEqual(resolveModelSelection(catalog(), "inherit", "low"), {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "low",
  });
  assert.deepEqual(resolveModelSelection(catalog(), "pro"), {
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    reasoningEffort: "medium",
  });
});

test("fails closed when a profile route is absent", () => {
  const models = catalog();
  models.groups = models.groups.filter((group) => group.id !== "deepseek-modlens");

  assert.throws(
    () => resolveModelSelection(models, "modlens-pro"),
    (error: unknown) => error instanceof ModelRoutingError && error.code === "profile_unavailable",
  );
});

test("rejects a reasoning effort not advertised by the selected model", () => {
  assert.throws(
    () => resolveModelSelection(catalog(), "pro", "ultra"),
    (error: unknown) =>
      error instanceof ModelRoutingError &&
      error.code === "reasoning_effort_unsupported" &&
      error.details.supportedEfforts instanceof Array,
  );
  assert.throws(
    () => resolveModelSelection(catalog(), "modlens-flash", "high"),
    (error: unknown) => error instanceof ModelRoutingError && error.code === "reasoning_effort_unsupported",
  );
});
