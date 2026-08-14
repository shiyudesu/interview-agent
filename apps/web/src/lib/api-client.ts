import { type ApiErrorDto, isErrorEnvelopeDto } from "@interview-agent/contracts/errors";

const JSON_CONTENT_TYPE_PATTERN = /^application\/(?:[\w.+-]*\+)?json(?:;|$)/iu;

export type ResponseDecoder<Value> = (value: unknown) => Value;

export interface ApiRequestOptions<Value> {
  readonly decode: ResponseDecoder<Value>;
  readonly headers?: HeadersInit;
  readonly json?: unknown;
  readonly method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly signal?: AbortSignal;
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiError: ApiErrorDto | null,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export class ApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiResponseError";
  }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl?.replace(/\/+$/u, "") ?? "";

  return {
    async request<Value>(
      path: `/api/${string}`,
      requestOptions: ApiRequestOptions<Value>,
    ): Promise<Value> {
      const headers = new Headers(requestOptions.headers);
      headers.set("accept", "application/json");
      if (requestOptions.json !== undefined) {
        headers.set("content-type", "application/json");
      }

      const requestInit: RequestInit = {
        cache: "no-store",
        credentials: "same-origin",
        headers,
        method: requestOptions.method ?? "GET",
      };
      if (requestOptions.json !== undefined) {
        requestInit.body = JSON.stringify(requestOptions.json);
      }
      if (requestOptions.signal !== undefined) {
        requestInit.signal = requestOptions.signal;
      }
      const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}${path}`, requestInit);
      const value = await readJsonResponse(response);
      if (!response.ok) {
        const failure = apiFailure(value);
        throw new ApiClientError(
          failure?.message ?? "请求失败，请稍后重试。",
          response.status,
          failure?.apiError ?? null,
        );
      }

      try {
        return requestOptions.decode(value);
      } catch {
        throw new ApiResponseError("服务器返回了无法识别的数据");
      }
    },
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new ApiResponseError("服务器返回了非 JSON 响应");
  }
  try {
    return await response.json();
  } catch {
    throw new ApiResponseError("服务器返回了无效 JSON");
  }
}

function apiFailure(
  value: unknown,
): { readonly apiError: ApiErrorDto; readonly message: string } | null {
  if (!isErrorEnvelopeDto(value)) {
    return null;
  }
  return {
    apiError: value.error,
    message: "message" in value.error ? value.error.message : value.error.failure.message,
  };
}

export const apiClient = createApiClient();
