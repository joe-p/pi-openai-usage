import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  CONFIG_BASENAME,
  DEFAULT_CUSTOM_ENDPOINT_USAGE_PATH,
  DEFAULT_USAGE_CONFIG,
  customEndpointUsageUrl,
  loadUsageConfig,
  type CustomEndpointConfig,
  type LoadedUsageConfig,
  type UsageConfig,
} from "../src/config";
import {
  findCustomEndpointForModel,
  globToRegExp,
  matchesCustomEndpoint,
  resolveCustomEndpointCredentials,
} from "../src/custom-endpoints";
import { registerUsageStatusController } from "../src/status-controller";
import { fetchCodexUsage, USAGE_ENDPOINT, type UsageClientPort, type UsageFetchResult } from "../src/usage-client";
import { decideUsageVisibility } from "../src/visibility";

const MODEL_PROXY_ENDPOINT: CustomEndpointConfig = {
  name: "model-proxy",
  baseUrl: "http://100.101.224.41:8080",
  usagePath: DEFAULT_CUSTOM_ENDPOINT_USAGE_PATH,
  models: ["model-proxy/codex/*"],
  auth: { provider: "model-proxy" },
};

function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), "pi-openai-usage-custom-endpoints-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadedConfig(effective: UsageConfig): LoadedUsageConfig {
  return {
    configPath: "/tmp/project/.pi/extensions/pi-openai-usage.json",
    projectConfigPath: "/tmp/project/.pi/extensions/pi-openai-usage.json",
    globalConfigPath: "/tmp/home/.pi/agent/extensions/pi-openai-usage.json",
    projectConfigExists: true,
    globalConfigExists: false,
    raw: { project: {}, global: {} },
    effective,
  };
}

function rawUsageResponse(): unknown {
  return {
    rate_limit: {
      primary_window: { limit_window_seconds: 18_000, used_percent: 25, reset_after_seconds: 300 },
      secondary_window: { limit_window_seconds: 604_800, used_percent: 50, reset_after_seconds: 600 },
    },
  };
}

describe("custom endpoint config", () => {
  it("parses customEndpoints and applies the default usage path", () => {
    const { root, cwd, home } = createTempProject();
    try {
      writeJson(join(home, ".pi", "agent", "extensions", CONFIG_BASENAME), {
        customEndpoints: [
          {
            name: "model-proxy",
            baseUrl: "http://100.101.224.41:8080/",
            models: ["model-proxy/codex/*"],
            auth: { provider: "model-proxy" },
          },
        ],
      });

      const loaded = loadUsageConfig({ cwd, home });

      expect(loaded.effective.customEndpoints).toEqual([MODEL_PROXY_ENDPOINT]);
      expect(customEndpointUsageUrl(loaded.effective.customEndpoints[0]!)).toBe(
        "http://100.101.224.41:8080/backend-api/wham/usage",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops custom endpoints without a name, base URL, or model patterns", () => {
    const { root, cwd, home } = createTempProject();
    try {
      writeJson(join(home, ".pi", "agent", "extensions", CONFIG_BASENAME), {
        customEndpoints: [
          { name: "no-base-url", models: ["*"] },
          { name: "no-models", baseUrl: "http://localhost:1234" },
          { baseUrl: "http://localhost:1234", models: ["*"] },
          { name: "kept", baseUrl: "http://localhost:1234", models: ["*"], usagePath: "usage" },
        ],
      });

      const loaded = loadUsageConfig({ cwd, home });

      expect(loaded.effective.customEndpoints).toEqual([
        {
          name: "kept",
          baseUrl: "http://localhost:1234",
          usagePath: "usage",
          models: ["*"],
          auth: {},
        },
      ]);
      expect(customEndpointUsageUrl(loaded.effective.customEndpoints[0]!)).toBe(
        "http://localhost:1234/usage",
      );
      expect(DEFAULT_USAGE_CONFIG.customEndpoints).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("custom endpoint matching", () => {
  it("matches model patterns against provider-prefixed and bare model ids", () => {
    expect(globToRegExp("model-proxy/codex/*").test("model-proxy/codex/gpt-5.6-sol")).toBe(true);
    expect(globToRegExp("model-proxy/codex/*").test("model-proxy/codex/")).toBe(true);
    expect(globToRegExp("model-proxy/codex/*").test("model-proxy/other/gpt-5.6-sol")).toBe(false);

    const endpoint = { ...MODEL_PROXY_ENDPOINT, models: ["codex/?pt-*"] };
    expect(matchesCustomEndpoint(endpoint, { provider: "model-proxy", id: "codex/gpt-5" })).toBe(true);
    expect(matchesCustomEndpoint(endpoint, { provider: "model-proxy", id: "codex/opus" })).toBe(false);
  });

  it("resolves the active model to its custom endpoint", () => {
    const endpoints = [MODEL_PROXY_ENDPOINT];

    expect(
      findCustomEndpointForModel(endpoints, { provider: "model-proxy", id: "codex/gpt-5.6-sol" }),
    ).toBe(MODEL_PROXY_ENDPOINT);
    expect(
      findCustomEndpointForModel(endpoints, { provider: "openai-codex", id: "gpt-5.6-codex" }),
    ).toBeUndefined();
    expect(findCustomEndpointForModel(endpoints, undefined)).toBeUndefined();
    expect(findCustomEndpointForModel(undefined, { provider: "model-proxy", id: "codex/x" })).toBeUndefined();
  });

  it("makes custom endpoint models visible even when the provider is not OpenAI", () => {
    const modelRegistry = { isUsingOAuth: vi.fn(() => false) };

    expect(
      decideUsageVisibility({
        showAlways: false,
        model: { provider: "model-proxy", id: "codex/gpt-5.6-sol" },
        modelRegistry,
        customEndpoints: [MODEL_PROXY_ENDPOINT],
      }),
    ).toEqual({ visible: true, reason: "custom_endpoint" });
    expect(
      decideUsageVisibility({
        showAlways: false,
        model: { provider: "model-proxy", id: "other-model" },
        modelRegistry,
        customEndpoints: [MODEL_PROXY_ENDPOINT],
      }),
    ).toEqual({ visible: false, reason: "ineligible_model" });
    expect(modelRegistry.isUsingOAuth).not.toHaveBeenCalled();
  });

  it("resolves credentials from the provider api key or an explicit api key", async () => {
    const registry = { getApiKeyForProvider: vi.fn(async () => "provider-key") };

    await expect(resolveCustomEndpointCredentials(MODEL_PROXY_ENDPOINT, registry)).resolves.toEqual({
      ok: true,
      credentials: { accessToken: "provider-key" },
    });
    expect(registry.getApiKeyForProvider).toHaveBeenCalledWith("model-proxy");

    await expect(
      resolveCustomEndpointCredentials(
        { ...MODEL_PROXY_ENDPOINT, auth: { apiKey: "inline-key" } },
        registry,
      ),
    ).resolves.toEqual({ ok: true, credentials: { accessToken: "inline-key" } });

    await expect(
      resolveCustomEndpointCredentials(MODEL_PROXY_ENDPOINT, {
        getApiKeyForProvider: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Missing credentials for provider "model-proxy" (model-proxy)',
    });

    await expect(
      resolveCustomEndpointCredentials({ ...MODEL_PROXY_ENDPOINT, auth: {} }, registry),
    ).resolves.toEqual({
      ok: false,
      message: 'Custom usage endpoint "model-proxy" has no auth.apiKey or auth.provider',
    });
  });
});

describe("custom endpoint usage requests", () => {
  it("requests the configured endpoint without the ChatGPT account id header", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(rawUsageResponse()), { status: 200 }),
    );

    const endpointUrl = customEndpointUsageUrl(MODEL_PROXY_ENDPOINT);
    const result = await fetchCodexUsage(
      { accessToken: "proxy-key" },
      { fetchImpl, endpointUrl },
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({
        headers: { accept: "*/*", authorization: "Bearer proxy-key" },
      }),
    );
    expect(endpointUrl).not.toBe(USAGE_ENDPOINT);
  });

  it("fetches proxied usage for a matching model and renders its widgets", async () => {
    const handlers = new Map<string, (event: { type: string }, ctx: unknown) => unknown>();
    const pi = {
      on(name: string, handler: (event: { type: string }, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;

    const fetchUsage = vi.fn(
      async (): Promise<UsageFetchResult> => ({ ok: true, raw: rawUsageResponse(), status: 200 }),
    );
    const usageClient: UsageClientPort = { fetchUsage };
    const getApiKeyForProvider = vi.fn(async () => "proxy-key");

    const ctx = {
      model: { provider: "model-proxy", id: "codex/gpt-5.6-sol" },
      modelRegistry: { isUsingOAuth: vi.fn(() => false), getApiKeyForProvider },
      ui: { setStatus: vi.fn() },
    };

    registerUsageStatusController(pi, {
      loadConfig: () =>
        loadedConfig({
          ...DEFAULT_USAGE_CONFIG,
          colors: { ...DEFAULT_USAGE_CONFIG.colors, scheme: "none" },
          customEndpoints: [MODEL_PROXY_ENDPOINT],
        }),
      resolveCredentials: vi.fn(async () => {
        throw new Error("OAuth credentials must not be used for custom endpoints");
      }),
      usageClient,
    });

    await handlers.get("session_start")?.({ type: "session_start" }, ctx);

    expect(getApiKeyForProvider).toHaveBeenCalledWith("model-proxy");
    expect(fetchUsage).toHaveBeenCalledWith(
      { accessToken: "proxy-key" },
      expect.objectContaining({
        endpointUrl: "http://100.101.224.41:8080/backend-api/wham/usage",
      }),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "openai-usage",
      expect.stringContaining("75%"),
    );
  });
});
