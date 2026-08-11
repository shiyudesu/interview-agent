import { createHmac } from "node:crypto";

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { account, type Database, session, user, verification } from "@interview-agent/db";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { type EmailOTPOptions, emailOTP } from "better-auth/plugins";

import type { ServerConfig } from "./config.js";
import type { EmailSender } from "./email-sender.js";

export const EMAIL_OTP_LENGTH = 6;
export const EMAIL_OTP_EXPIRES_IN_SECONDS = 5 * 60;
export const EMAIL_OTP_ALLOWED_ATTEMPTS = 3;
export const AUTH_SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
export const AUTH_SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export interface CreateAuthenticationInput {
  readonly database: Database;
  readonly config: Pick<ServerConfig, "environment" | "auth">;
  readonly emailSender: EmailSender;
}

export interface Authentication {
  readonly handler: (request: Request) => Promise<Response>;
  readonly options: BetterAuthOptions;
}

export class AuthenticationEmailDeliveryError extends Error {
  constructor() {
    super("Authentication email delivery failed");
    this.name = "AuthenticationEmailDeliveryError";
  }
}

export function createEmailOtpOptions(emailSender: EmailSender, secret: string): EmailOTPOptions {
  return {
    sendVerificationOTP: async ({ email, otp, type }) => {
      try {
        await emailSender.sendVerificationOtp({
          recipient: email,
          code: otp,
          purpose: type,
          expiresInSeconds: EMAIL_OTP_EXPIRES_IN_SECONDS,
        });
      } catch {
        throw new AuthenticationEmailDeliveryError();
      }
    },
    otpLength: EMAIL_OTP_LENGTH,
    expiresIn: EMAIL_OTP_EXPIRES_IN_SECONDS,
    allowedAttempts: EMAIL_OTP_ALLOWED_ATTEMPTS,
    storeOTP: {
      hash: async (otp) =>
        createHmac("sha256", secret).update("email-otp\0").update(otp).digest("hex"),
    },
    resendStrategy: "rotate",
    changeEmail: { enabled: false, verifyCurrentEmail: false },
  };
}

export function createAuthentication(input: CreateAuthenticationInput): Authentication {
  const github = input.config.auth.github;
  const origin = new URL(input.config.auth.baseUrl).origin;

  return betterAuth({
    appName: "Interview Agent",
    baseURL: input.config.auth.baseUrl,
    secret: input.config.auth.secret,
    database: drizzleAdapter(input.database, {
      provider: "pg",
      schema: { user, session, account, verification },
      transaction: true,
    }),
    trustedOrigins: [origin],
    socialProviders:
      github === undefined
        ? {}
        : {
            github: {
              clientId: github.clientId,
              clientSecret: github.clientSecret,
            },
          },
    account: {
      updateAccountOnSignIn: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: github === undefined ? [] : ["github"],
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    session: {
      expiresIn: AUTH_SESSION_EXPIRES_IN_SECONDS,
      updateAge: AUTH_SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: input.config.environment === "production",
    },
    telemetry: { enabled: false },
    plugins: [emailOTP(createEmailOtpOptions(input.emailSender, input.config.auth.secret))],
  });
}
