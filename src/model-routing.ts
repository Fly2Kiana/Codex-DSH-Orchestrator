import { DshRpcError, DshTransportError } from "./dsh-client.js";
import type { DshModelSelection, DshSessionModels } from "./dsh-types.js";

export const modelProfiles = [
  "inherit",
  "flash",
  "pro",
  "official-flash-vision",
  "modlens-flash",
  "modlens-pro",
] as const;

export type ModelProfile = (typeof modelProfiles)[number];

const profileRoutes: Record<Exclude<ModelProfile, "inherit">, { provider: string; model: string }> = {
  flash: { provider: "deepseek-official", model: "deepseek-v4-flash" },
  pro: { provider: "deepseek-official", model: "deepseek-v4-pro" },
  // Exact live catalog route observed read-only on 2026-08-26 (session.models):
  // provider deepseek-official advertises deepseek-v4-flash-vision-exp as
  // "DeepSeek-V4-Flash-Vision-Exp" with efforts off/low/high/max.
  "official-flash-vision": { provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" },
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

export const visualIntents = ["none", "required"] as const;

export type VisualIntent = (typeof visualIntents)[number];

export const complexityValues = ["low", "high"] as const;

export type Complexity = (typeof complexityValues)[number];

/** The only profiles a high-complexity visual request may choose explicitly. */
export const VISUAL_HIGH_CHOICES = ["official-flash-vision", "modlens-pro"] as const;

export type VisualHighChoice = (typeof VISUAL_HIGH_CHOICES)[number];

export interface RoutePolicyInput {
  visualIntent?: VisualIntent;
  complexity?: Complexity;
  modelProfile?: ModelProfile;
}

export type RoutePolicyDecision =
  | { decision: "profile"; profile: ModelProfile }
  | { decision: "user_choice_required"; message: string; choices: VisualHighChoice[] }
  | {
      decision: "policy_error";
      code: "visual_complexity_required" | "visual_fallback_only" | "visual_choice_unsupported";
      message: string;
    };

/**
 * Pure caller-contract policy resolver. It accepts only structured
 * intent/complexity/profile inputs, never inspects prompt text or image bytes,
 * and never calls DSH or persists configuration.
 *
 * Priority: an explicit caller/user modelProfile wins; otherwise visual-low
 * selects the official native Flash Vision, visual-high demands an explicit
 * user choice, and non-visual low/high select official Flash/Pro. Omitted
 * fields preserve the legacy inherit behavior.
 */
export function resolveRoutePolicy(input: RoutePolicyInput = {}): RoutePolicyDecision {
  const visualIntent = input.visualIntent ?? "none";
  const explicit = input.modelProfile;
  if (visualIntent === "required") {
    if (explicit !== undefined) {
      if (explicit === "modlens-flash") {
        return {
          decision: "policy_error",
          code: "visual_fallback_only",
          message:
            "modlens-flash is only the automatic terminal fallback for visual work; it is never a first-choice visual route",
        };
      }
      if (explicit === "official-flash-vision" || explicit === "modlens-pro") {
        return { decision: "profile", profile: explicit };
      }
      return {
        decision: "policy_error",
        code: "visual_choice_unsupported",
        message: `visual work cannot use model profile ${explicit}; choose official-flash-vision or modlens-pro`,
      };
    }
    if (input.complexity === undefined) {
      return {
        decision: "policy_error",
        code: "visual_complexity_required",
        message: "visualIntent=required requires an explicit complexity of low or high",
      };
    }
    if (input.complexity === "low") {
      return { decision: "profile", profile: "official-flash-vision" };
    }
    return {
      decision: "user_choice_required",
      message:
        "high-complexity visual work requires an explicit user choice between official native Flash Vision and ModLens Pro",
      choices: [...VISUAL_HIGH_CHOICES],
    };
  }
  if (explicit !== undefined) return { decision: "profile", profile: explicit };
  if (input.complexity === "low") return { decision: "profile", profile: "flash" };
  if (input.complexity === "high") return { decision: "profile", profile: "pro" };
  return { decision: "profile", profile: "inherit" };
}

/** Bounded attempts on the approved visual route before the single fallback. */
export const MAX_VISUAL_ROUTE_ATTEMPTS = 3;

export const routeFailureClasses = [
  "timeout",
  "unreachable",
  "user_cancelled",
  "invalid_input",
  "model_missing",
  "selection_mismatch",
  "policy_denied",
  "configuration_error",
  "unknown",
] as const;

export type RouteFailureClass = (typeof routeFailureClasses)[number];

const POLICY_DENIED_RPC_CODE = /(permission|policy|auth|credential|forbidden|denied|unauthorized|quota)/i;
const MODEL_MISSING_RPC_CODE = /(model|provider).*(not[-_ ]found|missing|unavailable)/i;

/**
 * Stable classification of a route-selection failure. Only timeout and
 * unreachable are force-majeure classes eligible for the bounded ModLens
 * Flash fallback; every other class fails closed with no fallback.
 */
export function classifyRouteFailure(error: unknown): RouteFailureClass {
  const names = new Set<string>();
  let current: unknown = error;
  while (current !== null && current !== undefined && typeof current === "object") {
    const name = (current as { name?: unknown }).name;
    if (typeof name === "string") names.add(name);
    current = (current as { cause?: unknown }).cause;
  }
  if (names.has("TimeoutError")) return "timeout";
  if (names.has("AbortError")) return "user_cancelled";
  if (error instanceof DshTransportError) {
    // Narrow classification: only an explicit timeout (handled above via the
    // cause chain), a failed Host connection, or an external HTTP 5xx counts
    // as force-majeure. Client/protocol failures (4xx, non-JSON payloads,
    // invalid envelopes, rpcId mismatches, schema mismatches) never trigger
    // bounded retries or the ModLens Flash fallback.
    const httpStatus = /HTTP ([1-5][0-9]{2})/.exec(error.message)?.[1];
    if (httpStatus !== undefined) {
      if (httpStatus === "401" || httpStatus === "403") return "policy_denied";
      if (httpStatus === "400" || httpStatus === "422") return "invalid_input";
      if (httpStatus === "404") return "model_missing";
      if (httpStatus.startsWith("5")) return "unreachable";
      return "configuration_error";
    }
    if (error.message.startsWith("failed to reach DSH Host at ")) return "unreachable";
    return "configuration_error";
  }
  if (error instanceof DshRpcError) {
    if (POLICY_DENIED_RPC_CODE.test(error.code)) return "policy_denied";
    if (MODEL_MISSING_RPC_CODE.test(error.code)) return "model_missing";
    return "unknown";
  }
  if (error instanceof ModelRoutingError) {
    switch (error.code) {
      case "profile_unavailable":
        return "model_missing";
      case "reasoning_effort_unsupported":
        return "invalid_input";
      case "selection_mismatch":
        return "selection_mismatch";
    }
  }
  if (names.has("ConfigError")) return "configuration_error";
  return "unknown";
}

export function isForceMajeureFailure(error: unknown): boolean {
  const classified = classifyRouteFailure(error);
  return classified === "timeout" || classified === "unreachable";
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
