import type { CustomEndpointConfig } from "./config";
import type { UsageRequestCredentials } from "./usage-client";

/**
 * Custom (proxy) usage endpoints.
 *
 * A custom endpoint lets the extension read subscription usage from an
 * OpenAI-compatible/Codex-compatible proxy instead of the ChatGPT backend
 * (`https://chatgpt.com/backend-api/wham/usage`). Endpoints are matched against
 * the active model by glob pattern, and their credentials come from Pi's model
 * registry (the provider named in the endpoint's `auth.provider`).
 */

export type CustomEndpointModel = {
  provider: string;
  id?: string;
};

export type CustomEndpointApiKeyRegistry = {
  getApiKeyForProvider?: (
    provider: string,
  ) => string | undefined | Promise<string | undefined>;
};

export type CustomEndpointCredentialResolution =
  | { ok: true; credentials: UsageRequestCredentials }
  | { ok: false; message: string };

const GLOB_SPECIAL_CHARACTERS = /[.+^${}()|[\]\\]/gu;

export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(GLOB_SPECIAL_CHARACTERS, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`, "u");
}

export function modelIdentifierCandidates(model: CustomEndpointModel): string[] {
  const candidates: string[] = [];
  if (model.id !== undefined && model.id.length > 0) {
    candidates.push(`${model.provider}/${model.id}`, model.id);
  } else {
    candidates.push(model.provider);
  }
  return candidates;
}

export function matchesCustomEndpoint(
  endpoint: CustomEndpointConfig,
  model: CustomEndpointModel,
): boolean {
  const candidates = modelIdentifierCandidates(model);
  return endpoint.models.some((pattern) => {
    const matcher = globToRegExp(pattern);
    return candidates.some((candidate) => matcher.test(candidate));
  });
}

export function findCustomEndpointForModel(
  endpoints: readonly CustomEndpointConfig[] | undefined,
  model: CustomEndpointModel | undefined,
): CustomEndpointConfig | undefined {
  if (endpoints === undefined || endpoints.length === 0 || model === undefined) return undefined;
  return endpoints.find((endpoint) => matchesCustomEndpoint(endpoint, model));
}

export async function resolveCustomEndpointCredentials(
  endpoint: CustomEndpointConfig,
  registry: CustomEndpointApiKeyRegistry | undefined,
): Promise<CustomEndpointCredentialResolution> {
  if (endpoint.auth.apiKey !== undefined && endpoint.auth.apiKey.length > 0) {
    return { ok: true, credentials: { accessToken: endpoint.auth.apiKey } };
  }

  const provider = endpoint.auth.provider;
  if (provider === undefined || provider.length === 0) {
    return {
      ok: false,
      message: `Custom usage endpoint "${endpoint.name}" has no auth.apiKey or auth.provider`,
    };
  }

  const getApiKeyForProvider = registry?.getApiKeyForProvider;
  if (getApiKeyForProvider === undefined) {
    return {
      ok: false,
      message: `No credentials available for provider "${provider}" (${endpoint.name})`,
    };
  }

  try {
    const apiKey = await getApiKeyForProvider.call(registry, provider);
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return {
        ok: false,
        message: `Missing credentials for provider "${provider}" (${endpoint.name})`,
      };
    }
    return { ok: true, credentials: { accessToken: apiKey.trim() } };
  } catch {
    return {
      ok: false,
      message: `Failed to resolve credentials for provider "${provider}" (${endpoint.name})`,
    };
  }
}
