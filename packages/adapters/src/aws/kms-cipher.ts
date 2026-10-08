import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { SecretCipher } from "@nailzify/core";

export interface KmsCipherConfig {
  readonly keyId: string;
  readonly region?: string;
  readonly client?: Pick<KMSClient, "send">;
}

export function createKmsCipher(config: KmsCipherConfig): SecretCipher {
  const client = config.client ?? new KMSClient(config.region ? { region: config.region } : {});
  return {
    async encrypt(plaintext, context) {
      const result = await client.send(new EncryptCommand({
        KeyId: config.keyId,
        Plaintext: Buffer.from(plaintext, "utf8"),
        EncryptionContext: { ...context },
      }));
      if (!result.CiphertextBlob) throw new Error("KMS returned no ciphertext");
      return Buffer.from(result.CiphertextBlob).toString("base64");
    },

    async decrypt(ciphertext, context) {
      const result = await client.send(new DecryptCommand({
        KeyId: config.keyId,
        CiphertextBlob: Buffer.from(ciphertext, "base64"),
        EncryptionContext: { ...context },
      }));
      if (!result.Plaintext) throw new Error("KMS returned no plaintext");
      return Buffer.from(result.Plaintext).toString("utf8");
    },
  };
}
