import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenCipher, TokenEncryptionError } from "./token-crypto.js";

describe("TokenCipher", () => {
  it("encrypts tokens with authenticated encryption", () => {
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    const encrypted = cipher.encrypt("server-only-token");

    expect(encrypted.toString("utf8")).not.toContain("server-only-token");
    expect(cipher.decrypt(encrypted)).toBe("server-only-token");
    encrypted[encrypted.length - 1] ^= 1;
    expect(() => cipher.decrypt(encrypted)).toThrow(TokenEncryptionError);
  });

  it("rejects an invalid key length", () => {
    expect(() => TokenCipher.fromBase64("invalid")).toThrow(TokenEncryptionError);
  });
});
