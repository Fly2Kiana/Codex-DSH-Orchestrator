import type { DshModelSelection, DshSessionModels } from "./dsh-types.js";

export const modelProfiles = ["inherit", "flash", "pro", "modlens-flash", "modlens-pro"] as const;

export type ModelProfile = (typeof modelProfiles)[number];

const profileRoutes: Record<Exclude<ModelProfile, "inherit">, { provider: string; model: string }> = {
  flash: { provider: "deepseek-official", model: "deepseek-v4-flash" },
  pro: { provider: "deepseek-official", model: "deepseek-v4-pro" },
  "modlens-flash": { provider: "deepseek-modlens", model: "deepseek-v4-flash" },
  "modlens-pro": { provider: "deepseek-modlens", model: "deepseek-v4-pro" },
};

export class ModelRoutingError extends Error {
  constructor(
    readonly code: "profile_unavailable" | "reasoning_effort_unsupported" | "selection_mismatch",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export function resolveModelSelection(
  catalog: DshSessionModels,
  profile: ModelProfile,
  requestedReasoningEffort?: string,
): DshModelSelection {
  const route = profile === "inherit" ? catalog.current : profileRoutes[profile];
  const group = catalog.groups.find((candidate) => candidate.id === route.provider);
  const model = group?.models.find((candidate) => candidate.id === route.model);
  if (group === undefined || model === undefined) {
    throw new ModelRoutingError(
      "profile_unavailable",
      `model profile ${profile} requires ${route.provider}/${route.model}, but that route is not in the DSH session catalog`,
      {
        profile,
        provider: route.provider,
        model: route.model,
        availableProviders: catalog.groups.map((candidate) => candidate.id),
        providerFailures: catalog.failures,
      },
    );
  }

  const reasoningEffort = requestedReasoningEffort ?? model.reasoning?.defaultEffort;
  if (reasoningEffort !== undefined) {
    const supportedEfforts = model.reasoning?.efforts.map((effort) => effort.id) ?? [];
    if (!supportedEfforts.includes(reasoningEffort)) {
      throw new ModelRoutingError(
        "reasoning_effort_unsupported",
        `reasoning effort ${reasoningEffort} is not advertised by ${route.provider}/${route.model}`,
        {
          profile,
          provider: route.provider,
          model: route.model,
          requestedReasoningEffort: reasoningEffort,
          supportedEfforts,
        },
      );
    }
  }

  return {
    provider: route.provider,
    model: route.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

export function verifyModelSelection(expected: DshModelSelection, catalog: DshSessionModels): DshModelSelection {
  const actual = catalog.current;
  const routeMatches = actual.provider === expected.provider && actual.model === expected.model;
  const effortMatches = expected.reasoningEffort === undefined || actual.reasoningEffort === expected.reasoningEffort;
  if (!catalog.routable || !routeMatches || !effortMatches) {
    throw new ModelRoutingError(
      "selection_mismatch",
      `DSH did not activate the requested model selection ${expected.provider}/${expected.model}`,
      { expected, actual, routable: catalog.routable, providerFailures: catalog.failures },
    );
  }
  return actual;
}
