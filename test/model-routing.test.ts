import assert from "node:assert/strict";
import { test } from "node:test";

import { DshRpcError, DshTransportError } from "../src/dsh-client.js";
import {
  classifyRouteFailure,
  isForceMajeureFailure,
  ModelRoutingError,
  resolveModelSelection,
  resolveRoutePolicy,
  type ModelProfile,
} from "../src/model-routing.js";
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
          {
            id: "deepseek-v4-flash-vision-exp",
            name: "DeepSeek-V4-Flash-Vision-Exp",
            reasoning: {
              efforts: [
                { id: "off", name: "Off" },
                { id: "low", name: "Low" },
                { id: "high", name: "High" },
                { id: "max", name: "Max" },
              ],
              defaultEffort: "high",
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
    // Live catalog ids observed read-only on 2026-08-26 (session.models).
    "official-flash-vision": { provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" },
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

test("official visual profile resolves to the exact live-catalog provider and model ids", () => {
  assert.deepEqual(resolveModelSelection(catalog(), "official-flash-vision"), {
    provider: "deepseek-official",
    model: "deepseek-v4-flash-vision-exp",
    reasoningEffort: "high",
  });
  assert.deepEqual(resolveModelSelection(catalog(), "official-flash-vision", "low"), {
    provider: "deepseek-official",
    model: "deepseek-v4-flash-vision-exp",
    reasoningEffort: "low",
  });
});

test("fails closed when the official visual route is absent from the catalog", () => {
  const models = catalog();
  models.groups = models.groups.map((group) =>
    group.id === "deepseek-official"
      ? { ...group, models: group.models.filter((model) => model.id !== "deepseek-v4-flash-vision-exp") }
      : group,
  );
  assert.throws(
    () => resolveModelSelection(models, "official-flash-vision"),
    (error: unknown) => error instanceof ModelRoutingError && error.code === "profile_unavailable",
  );
});

test("resolveRoutePolicy implements the non-visual low/high policy and explicit override priority", () => {
  assert.deepEqual(resolveRoutePolicy({}), { decision: "profile", profile: "inherit" });
  assert.deepEqual(resolveRoutePolicy({ complexity: "low" }), { decision: "profile", profile: "flash" });
  assert.deepEqual(resolveRoutePolicy({ complexity: "high" }), { decision: "profile", profile: "pro" });
  assert.deepEqual(resolveRoutePolicy({ visualIntent: "none", complexity: "low" }), {
    decision: "profile",
    profile: "flash",
  });
  assert.deepEqual(resolveRoutePolicy({ complexity: "high", modelProfile: "modlens-flash" }), {
    decision: "profile",
    profile: "modlens-flash",
  });
});

test("resolveRoutePolicy routes visual low to official Flash Vision and never selects ModLens Flash first", () => {
  assert.deepEqual(resolveRoutePolicy({ visualIntent: "required", complexity: "low" }), {
    decision: "profile",
    profile: "official-flash-vision",
  });
  assert.deepEqual(resolveRoutePolicy({ visualIntent: "required", complexity: "low", modelProfile: "modlens-pro" }), {
    decision: "profile",
    profile: "modlens-pro",
  });
  assert.deepEqual(
    resolveRoutePolicy({ visualIntent: "required", complexity: "low", modelProfile: "modlens-flash" }),
    {
      decision: "policy_error",
      code: "visual_fallback_only",
      message:
        "modlens-flash is only the automatic terminal fallback for visual work; it is never a first-choice visual route",
    },
  );
});

test("resolveRoutePolicy requires an explicit user choice for visual high complexity", () => {
  assert.deepEqual(resolveRoutePolicy({ visualIntent: "required", complexity: "high" }), {
    decision: "user_choice_required",
    message:
      "high-complexity visual work requires an explicit user choice between official native Flash Vision and ModLens Pro",
    choices: ["official-flash-vision", "modlens-pro"],
  });
  assert.deepEqual(
    resolveRoutePolicy({ visualIntent: "required", complexity: "high", modelProfile: "official-flash-vision" }),
    { decision: "profile", profile: "official-flash-vision" },
  );
  assert.deepEqual(
    resolveRoutePolicy({ visualIntent: "required", complexity: "high", modelProfile: "modlens-pro" }),
    { decision: "profile", profile: "modlens-pro" },
  );
  assert.deepEqual(resolveRoutePolicy({ visualIntent: "required", complexity: "high", modelProfile: "pro" }), {
    decision: "policy_error",
    code: "visual_choice_unsupported",
    message: "visual work cannot use model profile pro; choose official-flash-vision or modlens-pro",
  });
  assert.deepEqual(resolveRoutePolicy({ visualIntent: "required", modelProfile: "official-flash-vision" }), {
    decision: "profile",
    profile: "official-flash-vision",
  });
  assert.deepEqual(resolveRoutePolicy({ visualIntent: "required" }), {
    decision: "policy_error",
    code: "visual_complexity_required",
    message: "visualIntent=required requires an explicit complexity of low or high",
  });
});

test("classifyRouteFailure maps failures to the stable route failure classes", () => {
  assert.equal(
    classifyRouteFailure(new DshTransportError("failed to reach DSH Host at http://127.0.0.1:3080: fetch failed")),
    "unreachable",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 503")),
    "unreachable",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 401")),
    "policy_denied",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 403")),
    "policy_denied",
  );
  assert.equal(
    classifyRouteFailure(
      new DshTransportError("timed out", Object.assign(new Error("aborted"), { name: "TimeoutError" })),
    ),
    "timeout",
  );
  assert.equal(
    classifyRouteFailure(
      new DshTransportError("aborted", Object.assign(new Error("aborted"), { name: "AbortError" })),
    ),
    "user_cancelled",
  );
  assert.equal(classifyRouteFailure(new DshRpcError("permission-denied", "not allowed", {})), "policy_denied");
  assert.equal(classifyRouteFailure(new DshRpcError("credential-invalid", "bad key", {})), "policy_denied");
  assert.equal(classifyRouteFailure(new DshRpcError("model-not-found", "missing", {})), "model_missing");
  assert.equal(classifyRouteFailure(new DshRpcError("provider-failed", "route unavailable", {})), "unknown");
  assert.equal(
    classifyRouteFailure(new ModelRoutingError("profile_unavailable", "absent")),
    "model_missing",
  );
  assert.equal(
    classifyRouteFailure(new ModelRoutingError("reasoning_effort_unsupported", "bad effort")),
    "invalid_input",
  );
  assert.equal(
    classifyRouteFailure(new ModelRoutingError("selection_mismatch", "not active")),
    "selection_mismatch",
  );
  assert.equal(
    classifyRouteFailure(Object.assign(new Error("bad config"), { name: "ConfigError" })),
    "configuration_error",
  );
  assert.equal(classifyRouteFailure(new Error("response lost")), "unknown");
});

test("narrow transport classification: 4xx and protocol errors never trigger while 5xx does", () => {
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 400")),
    "invalid_input",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.selectModel: HTTP 404")),
    "model_missing",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.selectModel: HTTP 422")),
    "invalid_input",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 405")),
    "configuration_error",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 429")),
    "configuration_error",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 500")),
    "unreachable",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH transport failure for session.models: HTTP 502")),
    "unreachable",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("DSH returned non-JSON data for session.models")),
    "configuration_error",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("invalid DSH server-response envelope for session.models: value: invalid")),
    "configuration_error",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("mismatched DSH rpcId in response for session.models")),
    "configuration_error",
  );
  assert.equal(
    classifyRouteFailure(new DshTransportError("invalid DSH response value for session.models: model: invalid")),
    "configuration_error",
  );
  assert.equal(isForceMajeureFailure(new DshTransportError("DSH transport failure for session.models: HTTP 500")), true);
  assert.equal(isForceMajeureFailure(new DshTransportError("DSH transport failure for session.models: HTTP 400")), false);
  assert.equal(isForceMajeureFailure(new DshTransportError("DSH returned non-JSON data for session.models")), false);
});

test("only timeout and unreachable failures are force-majeure fallback triggers", () => {
  assert.equal(
    isForceMajeureFailure(new DshTransportError("failed to reach DSH Host at http://127.0.0.1:3080: fetch failed")),
    true,
  );
  assert.equal(isForceMajeureFailure(Object.assign(new Error("timed out"), { name: "TimeoutError" })), true);
  assert.equal(isForceMajeureFailure(new Error("response lost")), false);
  assert.equal(isForceMajeureFailure(new DshRpcError("permission-denied", "no", {})), false);
  assert.equal(isForceMajeureFailure(new ModelRoutingError("profile_unavailable", "absent")), false);
  assert.equal(isForceMajeureFailure(new ModelRoutingError("reasoning_effort_unsupported", "bad")), false);
  assert.equal(isForceMajeureFailure(new ModelRoutingError("selection_mismatch", "no")), false);
});
