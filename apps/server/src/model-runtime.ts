import {
  type Api,
  type ApiKeyCredential,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthContext,
  type AuthResult,
  type Context,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  type FauxProviderHandle,
  fauxProvider,
  type Model,
  type Models,
  type ModelsSimpleStreamOptions,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders, radiusProvider } from "@earendil-works/pi-ai/providers/all";

import type { ServerConfig } from "./config.js";

export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(`Invalid model configuration: ${message}`);
    this.name = "ModelConfigurationError";
  }
}

export interface FauxModelRuntime {
  readonly kind: "faux";
  readonly model: Model<string>;
  readonly client: FixedModelClient<string>;
  readonly faux: FauxRuntimeController;
}

export interface RealModelRuntime {
  readonly kind: "real";
  readonly model: Model<Api>;
  readonly client: FixedModelClient<Api>;
}

export type ModelRuntime = FauxModelRuntime | RealModelRuntime;
export const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 10_000;

export type FauxRuntimeController = Readonly<
  Pick<FauxProviderHandle, "appendResponses" | "getPendingResponseCount" | "setResponses">
>;

export class FixedModelClient<TApi extends Api> {
  readonly #models: Models;
  readonly #model: Model<TApi>;

  constructor(models: Models, model: Model<TApi>) {
    this.#models = models;
    this.#model = model;
  }

  async getAuth(): Promise<AuthResult> {
    const auth = await this.#models.getAuth(this.#model);
    if (auth === undefined) {
      throw new ModelConfigurationError("startup-selected provider authentication is unavailable");
    }
    return auth;
  }

  complete(context: Context): Promise<AssistantMessage> {
    return this.#models.complete(this.#model, context);
  }

  completeStructured(context: Context): Promise<AssistantMessage> {
    const options: ModelsSimpleStreamOptions = {
      maxRetries: 0,
    };
    return this.#models.completeSimple(this.#model, context, options);
  }

  stream(context: Context): AssistantMessageEventStream {
    return this.#models.stream(this.#model, context);
  }

  streamSimple(context: Context): AssistantMessageEventStream {
    return this.#models.streamSimple(this.#model, context);
  }
}

declare module "fastify" {
  interface FastifyInstance {
    modelRuntime: ModelRuntime;
  }
}

function requireNonBlank(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new ModelConfigurationError(`${name} must not be blank`);
  }
}

function validateBaseUrl(baseUrl: string | undefined): void {
  if (baseUrl === undefined) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ModelConfigurationError("MODEL_BASE_URL must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelConfigurationError("MODEL_BASE_URL must use http or https");
  }
}

function validateEffectiveBaseUrl(baseUrl: string, provider: string): void {
  if (baseUrl.length === 0 || baseUrl.includes("{") || baseUrl.includes("}")) {
    throw new ModelConfigurationError(
      `MODEL_BASE_URL is required for provider "${provider}" because its catalog endpoint is not directly usable`,
    );
  }
  validateBaseUrl(baseUrl);
}

function configureModel<TApi extends Api>(
  model: Model<TApi>,
  baseUrl: string | undefined,
): Model<TApi> {
  return freezeModel(baseUrl === undefined ? model : { ...model, baseUrl });
}

function freezeModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
  return deepFreeze(structuredClone(model));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key));
    }
    Object.freeze(value);
  }
  return value;
}

function fixedProvider(source: Provider, model: Model<Api>): Provider {
  const stream = source.stream.bind(source);
  const streamSimple = source.streamSimple.bind(source);
  const fetchDeferred = source.fetchDeferred?.bind(source);
  const cancelDeferred = source.cancelDeferred?.bind(source);

  return {
    id: source.id,
    name: source.name,
    baseUrl: model.baseUrl,
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    auth: source.auth,
    getModels: () => [model],
    stream: (requestModel, context, options) => {
      assertSelectedModel(requestModel, model);
      return stream(model, context, options);
    },
    streamSimple: (requestModel, context, options) => {
      assertSelectedModel(requestModel, model);
      return streamSimple(model, context, options);
    },
    ...(fetchDeferred === undefined
      ? {}
      : {
          fetchDeferred: (requestModel, handle, options) => {
            assertSelectedModel(requestModel, model);
            return fetchDeferred(model, handle, options);
          },
        }),
    ...(cancelDeferred === undefined
      ? {}
      : {
          cancelDeferred: (requestModel, handle, options) => {
            assertSelectedModel(requestModel, model);
            return cancelDeferred(model, handle, options);
          },
        }),
  };
}

function assertSelectedModel(requested: Model<Api>, selected: Model<Api>): void {
  if (
    requested.provider !== selected.provider ||
    requested.id !== selected.id ||
    requested.api !== selected.api ||
    requested.baseUrl !== selected.baseUrl
  ) {
    throw new ModelConfigurationError("runtime model switching is not allowed");
  }
}

function createFauxRuntime(
  config: Extract<ServerConfig["model"], { provider: "faux" }>,
): FauxModelRuntime {
  const faux = fauxProvider({
    provider: config.provider,
    models: [{ id: config.id, name: config.id }],
    tokensPerSecond: 0,
    tokenSize: { min: 4, max: 4 },
  });
  const model = configureModel(faux.getModel(), config.baseUrl);
  const publicModel = freezeModel({ ...model });
  const selectedModels = createModels();
  selectedModels.setProvider(fixedProvider(faux.provider, model));

  return {
    kind: "faux",
    model: publicModel,
    client: new FixedModelClient(selectedModels, model),
    faux: Object.freeze({
      setResponses: faux.setResponses.bind(faux),
      appendResponses: faux.appendResponses.bind(faux),
      getPendingResponseCount: faux.getPendingResponseCount.bind(faux),
    }),
  };
}

async function createRealRuntime(config: {
  readonly provider: string;
  readonly id: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}): Promise<RealModelRuntime> {
  requireNonBlank(config.apiKey, "MODEL_API_KEY");

  const provider =
    config.provider === "radius"
      ? radiusProvider(config.baseUrl === undefined ? {} : { gateway: config.baseUrl })
      : builtinProviders().find((candidate) => candidate.id === config.provider);
  if (provider === undefined) {
    throw new ModelConfigurationError(`unsupported MODEL_PROVIDER "${config.provider}"`);
  }

  const credentials = new FixedCredentialStore(provider.id, config.apiKey);
  const catalog = createModels({
    credentials,
    authContext: EMPTY_AUTH_CONTEXT,
  });
  catalog.setProvider(provider);
  let sourceModel = provider.getModels().find((candidate) => candidate.id === config.id);
  if (sourceModel === undefined && provider.refreshModels !== undefined) {
    const refresh = await catalog.refresh({
      allowNetwork: true,
      force: true,
      providers: [provider.id],
      signal: AbortSignal.timeout(MODEL_CATALOG_REFRESH_TIMEOUT_MS),
    });
    if (refresh.aborted) {
      throw new ModelConfigurationError(
        `provider "${provider.id}" model catalog refresh timed out`,
      );
    }
    const refreshError = refresh.errors.get(provider.id);
    if (refreshError !== undefined) {
      throw new ModelConfigurationError(`provider "${provider.id}" model catalog refresh failed`);
    }
    sourceModel = provider.getModels().find((candidate) => candidate.id === config.id);
  }
  if (sourceModel === undefined) {
    throw new ModelConfigurationError(
      `MODEL_ID "${config.id}" is not available from provider "${config.provider}"`,
    );
  }

  const model = configureModel(
    sourceModel,
    config.provider === "radius" ? undefined : config.baseUrl,
  );
  const publicModel = freezeModel({ ...model });
  validateEffectiveBaseUrl(model.baseUrl, config.provider);
  const selectedModels = createModels({
    credentials,
    authContext: EMPTY_AUTH_CONTEXT,
  });
  selectedModels.setProvider(fixedProvider(provider, model));
  const resolvedAuth = await selectedModels.getAuth(model);
  if (resolvedAuth === undefined) {
    throw new ModelConfigurationError(
      `MODEL_PROVIDER "${config.provider}" cannot resolve authentication from MODEL_API_KEY alone`,
    );
  }

  return {
    kind: "real",
    model: publicModel,
    client: new FixedModelClient(selectedModels, model),
  };
}

export async function createModelRuntime(config: ServerConfig["model"]): Promise<ModelRuntime> {
  requireNonBlank(config.provider, "MODEL_PROVIDER");
  requireNonBlank(config.id, "MODEL_ID");
  validateBaseUrl(config.baseUrl);

  if (config.provider === "faux") {
    if ("apiKey" in config) {
      throw new ModelConfigurationError("the Faux Provider must not receive MODEL_API_KEY");
    }
    return createFauxRuntime(config);
  }

  if (!("apiKey" in config)) {
    throw new ModelConfigurationError("MODEL_API_KEY is required for a real provider");
  }
  return createRealRuntime(config);
}

const EMPTY_AUTH_CONTEXT: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

class FixedCredentialStore implements CredentialStore {
  private readonly credential: Credential;

  constructor(
    private readonly providerId: string,
    apiKey: string,
  ) {
    this.credential = {
      type: "api_key",
      key: apiKey,
    } satisfies ApiKeyCredential;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === this.providerId ? this.credential : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [{ providerId: this.providerId, type: this.credential.type }];
  }

  async modify(
    providerId: string,
    _update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId === this.providerId) {
      throw new ModelConfigurationError("startup-configured model credentials are immutable");
    }
    return undefined;
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === this.providerId) {
      throw new ModelConfigurationError("startup-configured model credentials cannot be removed");
    }
  }
}
