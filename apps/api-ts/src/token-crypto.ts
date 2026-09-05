import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class TokenEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenEncryptionError";
  }
}

export class TokenCipher {
  private constructor(private readonly key: Buffer) {}

  static fromBase64(encodedKey: string): TokenCipher {
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) throw new TokenEncryptionError("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    return new TokenCipher(key);
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length <= IV_LENGTH + AUTH_TAG_LENGTH) throw new TokenEncryptionError("Encrypted token payload is invalid");
    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new TokenEncryptionError("Encrypted token payload could not be authenticated");
    }
  }
}
