import nodemailer, { type SendMailOptions } from "nodemailer";

import type { ServerConfig } from "./config.js";

export type VerificationOtpPurpose =
  | "sign-in"
  | "email-verification"
  | "forget-password"
  | "change-email";

export interface VerificationOtpEmail {
  readonly recipient: string;
  readonly code: string;
  readonly purpose: VerificationOtpPurpose;
  readonly expiresInSeconds: number;
}

export interface EmailSender {
  sendVerificationOtp(message: VerificationOtpEmail): Promise<void>;
}

export interface EmailDeliveryLogger {
  info(bindings: Readonly<Record<string, unknown>>, message: string): void;
  error(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export interface EmailTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
}

export class NodemailerEmailSender implements EmailSender {
  constructor(
    private readonly transport: EmailTransport,
    private readonly from: string,
    private readonly logger: EmailDeliveryLogger,
  ) {}

  async sendVerificationOtp(message: VerificationOtpEmail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: message.recipient,
        subject: otpSubject(message.purpose),
        text: `你的验证码是 ${message.code}。验证码将在 ${Math.ceil(message.expiresInSeconds / 60)} 分钟后过期，请勿转发给他人。`,
      });
      this.logger.info(
        { event: "auth_email_sent", purpose: message.purpose },
        "Authentication email sent",
      );
    } catch (error) {
      this.logger.error(
        { event: "auth_email_failed", purpose: message.purpose },
        "Authentication email delivery failed",
      );
      throw error;
    }
  }
}

export function createNodemailerEmailSender(
  config: ServerConfig["email"],
  logger: EmailDeliveryLogger,
): EmailSender {
  return new NodemailerEmailSender(
    nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
    }),
    config.from,
    logger,
  );
}

function otpSubject(purpose: VerificationOtpPurpose): string {
  switch (purpose) {
    case "sign-in":
      return "模拟面试登录验证码";
    case "email-verification":
      return "模拟面试邮箱验证";
    case "forget-password":
      return "模拟面试密码重置验证码";
    case "change-email":
      return "模拟面试邮箱变更验证码";
  }
}
