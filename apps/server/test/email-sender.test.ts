import { describe, expect, it, vi } from "vitest";

import {
  type EmailDeliveryLogger,
  NodemailerEmailSender,
  type VerificationOtpEmail,
} from "../src/email-sender.js";

const message: VerificationOtpEmail = {
  recipient: "candidate@example.test",
  code: "123456",
  purpose: "sign-in",
  expiresInSeconds: 300,
};

function logger() {
  return {
    info: vi.fn<EmailDeliveryLogger["info"]>(),
    error: vi.fn<EmailDeliveryLogger["error"]>(),
  };
}

describe("NodemailerEmailSender", () => {
  it("sends a text-only OTP email and logs no recipient or code", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "mail-1" }));
    const deliveryLogger = logger();
    const sender = new NodemailerEmailSender(
      { sendMail },
      "interview-agent@example.test",
      deliveryLogger,
    );

    await sender.sendVerificationOtp(message);

    expect(sendMail).toHaveBeenCalledWith({
      from: "interview-agent@example.test",
      to: message.recipient,
      subject: "模拟面试登录验证码",
      text: "你的验证码是 123456。验证码将在 5 分钟后过期，请勿转发给他人。",
    });
    expect(deliveryLogger.info).toHaveBeenCalledWith(
      { event: "auth_email_sent", purpose: "sign-in" },
      "Authentication email sent",
    );
    const logged = JSON.stringify(deliveryLogger.info.mock.calls);
    expect(logged).not.toContain(message.recipient);
    expect(logged).not.toContain(message.code);
    expect(deliveryLogger.error).not.toHaveBeenCalled();
  });

  it("rethrows delivery failures after a redacted failure log", async () => {
    const failure = new Error(`SMTP rejected ${message.recipient} with ${message.code}`);
    const deliveryLogger = logger();
    const sender = new NodemailerEmailSender(
      { sendMail: vi.fn(async () => Promise.reject(failure)) },
      "interview-agent@example.test",
      deliveryLogger,
    );

    await expect(sender.sendVerificationOtp(message)).rejects.toBe(failure);
    expect(deliveryLogger.error).toHaveBeenCalledWith(
      { event: "auth_email_failed", purpose: "sign-in" },
      "Authentication email delivery failed",
    );
    const logged = JSON.stringify(deliveryLogger.error.mock.calls);
    expect(logged).not.toContain(message.recipient);
    expect(logged).not.toContain(message.code);
  });
});
