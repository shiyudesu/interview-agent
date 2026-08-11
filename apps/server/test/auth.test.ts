import { createDatabaseClient } from "@interview-agent/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_SESSION_EXPIRES_IN_SECONDS,
  AUTH_SESSION_UPDATE_AGE_SECONDS,
  AuthenticationEmailDeliveryError,
  createAuthentication,
  createEmailOtpOptions,
  EMAIL_OTP_ALLOWED_ATTEMPTS,
  EMAIL_OTP_EXPIRES_IN_SECONDS,
  EMAIL_OTP_LENGTH,
} from "../src/auth.js";
import type { ServerConfig } from "../src/config.js";

const clients: ReturnType<typeof createDatabaseClient>[] = [];

function authConfig(
  changes: Partial<Pick<ServerConfig, "environment" | "auth">> = {},
): Pick<ServerConfig, "environment" | "auth"> {
  return {
    environment: changes.environment ?? "test",
    auth: changes.auth ?? {
      secret: "0123456789abcdef0123456789abcdef",
      baseUrl: "http://localhost:3000",
      github: {
        clientId: "github-client",
        clientSecret: "github-secret",
      },
    },
  };
}

function database() {
  const client = createDatabaseClient({
    databaseUrl: "postgresql://unused:unused@localhost:5432/unused",
  });
  clients.push(client);
  return client.database;
}

function emailSender(sendVerificationOtp = vi.fn(async () => undefined)) {
  return { sendVerificationOtp };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("createAuthentication", () => {
  it("configures PostgreSQL sessions, GitHub, and explicit different-email linking", () => {
    const auth = createAuthentication({
      database: database(),
      config: authConfig({ environment: "production" }),
      emailSender: emailSender(),
    });

    expect(auth.options.baseURL).toBe("http://localhost:3000");
    expect(auth.options.trustedOrigins).toEqual(["http://localhost:3000"]);
    expect(auth.options.socialProviders).toEqual({
      github: {
        clientId: "github-client",
        clientSecret: "github-secret",
      },
    });
    expect(auth.options.account).toMatchObject({
      updateAccountOnSignIn: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: ["github"],
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    });
    expect(auth.options.user).toMatchObject({
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    });
    expect(auth.options.session).toMatchObject({
      expiresIn: AUTH_SESSION_EXPIRES_IN_SECONDS,
      updateAge: AUTH_SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
    });
    expect(auth.options.advanced).toMatchObject({ useSecureCookies: true });
    expect(auth.options.telemetry).toEqual({ enabled: false });
    expect(auth.options.plugins?.map((plugin) => plugin.id)).toContain("email-otp");
  });

  it("omits GitHub when OAuth credentials are not configured", () => {
    const auth = createAuthentication({
      database: database(),
      config: authConfig({
        auth: {
          secret: "0123456789abcdef0123456789abcdef",
          baseUrl: "http://localhost:3000",
        },
      }),
      emailSender: emailSender(),
    });

    expect(auth.options.socialProviders).toEqual({});
    expect(auth.options.account?.accountLinking?.trustedProviders).toEqual([]);
    expect(auth.options.advanced).toMatchObject({ useSecureCookies: false });
  });

  it("uses bounded hashed rotating email OTP settings and delegates delivery", async () => {
    const sendVerificationOtp = vi.fn(async () => undefined);
    const options = createEmailOtpOptions(
      emailSender(sendVerificationOtp),
      "0123456789abcdef0123456789abcdef",
    );
    const message = {
      email: "candidate@example.test",
      otp: "123456",
      type: "sign-in" as const,
    };

    expect(options).toMatchObject({
      otpLength: EMAIL_OTP_LENGTH,
      expiresIn: EMAIL_OTP_EXPIRES_IN_SECONDS,
      allowedAttempts: EMAIL_OTP_ALLOWED_ATTEMPTS,
      resendStrategy: "rotate",
      changeEmail: { enabled: false, verifyCurrentEmail: false },
    });
    expect(options.storeOTP).toEqual({ hash: expect.any(Function) });
    if (typeof options.storeOTP !== "object" || !("hash" in options.storeOTP)) {
      throw new Error("Expected custom OTP hash storage");
    }
    await expect(options.storeOTP.hash("123456")).resolves.toMatch(/^[0-9a-f]{64}$/u);
    await expect(options.storeOTP.hash("123456")).resolves.not.toBe(
      "8d969eef6ecad3c29a3a629280e686cff8caedb10f60a93c27608d3f0a3981",
    );
    await options.sendVerificationOTP(message);
    expect(sendVerificationOtp).toHaveBeenCalledWith({
      recipient: message.email,
      code: message.otp,
      purpose: message.type,
      expiresInSeconds: EMAIL_OTP_EXPIRES_IN_SECONDS,
    });
  });

  it("replaces SMTP failures with a credential-free authentication error", async () => {
    const rawFailure = new Error("SMTP rejected candidate@example.test with OTP 123456");
    const options = createEmailOtpOptions(
      emailSender(vi.fn(async () => Promise.reject(rawFailure))),
      "0123456789abcdef0123456789abcdef",
    );

    await expect(
      options.sendVerificationOTP({
        email: "candidate@example.test",
        otp: "123456",
        type: "sign-in",
      }),
    ).rejects.toEqual(new AuthenticationEmailDeliveryError());
  });
});
