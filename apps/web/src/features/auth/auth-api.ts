export interface AuthClientOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export class AuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

export function createAuthClient(options: AuthClientOptions = {}) {
  async function post(path: `/api/auth/${string}`, body?: unknown): Promise<unknown> {
    const requestInit: RequestInit = {
      credentials: "same-origin",
      method: "POST",
    };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
      requestInit.headers = { "content-type": "application/json" };
    }
    const response = await (options.fetch ?? globalThis.fetch)(path, requestInit);
    const value = await optionalJson(response);
    if (!response.ok) {
      throw new AuthRequestError(authFailureMessage(response.status), response.status);
    }
    return value;
  }

  return {
    async sendEmailOtp(email: string): Promise<void> {
      await post("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      });
    },
    async signInWithEmailOtp(input: {
      readonly email: string;
      readonly name?: string;
      readonly otp: string;
    }): Promise<void> {
      await post("/api/auth/sign-in/email-otp", {
        email: input.email,
        otp: input.otp,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
    },
    async beginGitHubSignIn(callbackURL: string, errorCallbackURL: string): Promise<string> {
      return socialRedirect(
        await post("/api/auth/sign-in/social", {
          callbackURL,
          errorCallbackURL,
          provider: "github",
        }),
      );
    },
    async beginGitHubLink(callbackURL: string, errorCallbackURL: string): Promise<string> {
      return socialRedirect(
        await post("/api/auth/link-social", {
          callbackURL,
          errorCallbackURL,
          provider: "github",
        }),
      );
    },
    async signOut(): Promise<void> {
      await post("/api/auth/sign-out");
    },
  };
}

async function optionalJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function socialRedirect(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw new AuthRequestError("登录服务没有返回有效跳转地址。", 502);
  }
  return value.url;
}

function authFailureMessage(status: number): string {
  if (status === 429) {
    return "操作过于频繁，请稍后再试。";
  }
  if (status === 400 || status === 401 || status === 403) {
    return "登录信息无效或已过期，请重新尝试。";
  }
  return "认证请求暂时无法完成，请稍后再试。";
}

export const authClient = createAuthClient();
