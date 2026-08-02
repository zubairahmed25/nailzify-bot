import { describe, expect, it } from "vitest";
import { signSessionTokenForTest, verifySessionToken } from "./verify-session-token.js";

const SECRET = "shpss_test_secret_value";
const API_KEY = "12345test-api-key";
const SHOP_DOMAIN = "nailzify.myshopify.com";
const DEST = `https://${SHOP_DOMAIN}`;

const NOW_SECONDS = 1_700_000_300;
const now = () => NOW_SECONDS * 1000;

function sign(
  claims: Partial<{
    iss: string;
    dest: string;
    aud: string;
    sub: string;
    exp: number;
    nbf: number;
  }>,
  secret = SECRET,
): string {
  return signSessionTokenForTest(
    {
      iss: `${DEST}/admin`,
      dest: DEST,
      aud: API_KEY,
      sub: "merchant-user-1",
      exp: NOW_SECONDS + 60,
      nbf: NOW_SECONDS - 5,
      ...claims,
    },
    secret,
  );
}

const verify = (token: string) =>
  verifySessionToken(`Bearer ${token}`, SECRET, API_KEY, SHOP_DOMAIN, { now });

describe("verification", () => {
  it("accepts a correctly signed, fresh token", () => {
    const result = verify(sign({}));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.shop).toBe(SHOP_DOMAIN);
      expect(result.userId).toBe("merchant-user-1");
    }
  });

  it("rejects a token signed with the wrong secret", () => {
    // THE ATTACK THIS EXISTS FOR: forging admin-page identity to reach an
    // endpoint that can write into the document bucket and DynamoDB.
    const result = verify(sign({}, "wrong-secret"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });

  it("rejects a tampered payload", () => {
    const token = sign({});
    const [header, payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        iss: `${DEST}/admin`,
        dest: DEST,
        aud: API_KEY,
        sub: "attacker",
        exp: NOW_SECONDS + 60,
        nbf: NOW_SECONDS - 5,
      }),
      "utf8",
    ).toString("base64url");

    expect(verify(`${header}.${tamperedPayload}.${signature}`).ok).toBe(false);
  });

  it("rejects a token missing the bearer prefix", () => {
    const result = verifySessionToken(sign({}), SECRET, API_KEY, SHOP_DOMAIN, { now });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing bearer token");
  });

  it("rejects a missing Authorization header", () => {
    const result = verifySessionToken(undefined, SECRET, API_KEY, SHOP_DOMAIN, { now });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing bearer token");
  });

  it("rejects a malformed token", () => {
    const result = verify("not-a-jwt");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed token");
  });

  it("refuses to verify when no secret is configured", () => {
    // Fail CLOSED. An empty secret that "verified" would let anyone write
    // into the document bucket.
    const result = verifySessionToken(`Bearer ${sign({})}`, "", API_KEY, SHOP_DOMAIN, { now });

    expect(result.ok).toBe(false);
  });

  it("refuses to verify when no api key is configured", () => {
    const result = verifySessionToken(`Bearer ${sign({})}`, SECRET, "", SHOP_DOMAIN, { now });

    expect(result.ok).toBe(false);
  });
});

describe("expiry and clock tolerance", () => {
  it("rejects an expired token", () => {
    const result = verify(sign({ exp: NOW_SECONDS - 100 }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("token expired");
  });

  it("accepts a token expired by less than the clock tolerance", () => {
    const result = verify(sign({ exp: NOW_SECONDS - 5 }));

    expect(result.ok).toBe(true);
  });

  it("rejects a not-yet-valid token", () => {
    const result = verify(sign({ nbf: NOW_SECONDS + 100 }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("token not yet valid");
  });

  it("accepts a token that becomes valid within the clock tolerance", () => {
    const result = verify(sign({ nbf: NOW_SECONDS + 5 }));

    expect(result.ok).toBe(true);
  });
});

describe("claim validation", () => {
  it("rejects an audience that does not match the app's client id", () => {
    const result = verify(sign({ aud: "someone-elses-app" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("audience mismatch");
  });

  it("rejects a token minted for a different shop", () => {
    // Single-tenant app: a token for any OTHER shop is as invalid as a forged
    // one, even if it is genuinely Shopify-signed.
    const result = verify(sign({ dest: "attacker.myshopify.com" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("shop mismatch");
  });

  it("rejects an issuer that doesn't match the destination shop", () => {
    const result = verify(sign({ iss: "https://attacker.myshopify.com/admin" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("issuer mismatch");
  });

  it("rejects a token with no subject", () => {
    const result = verify(sign({ sub: "" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing subject");
  });
});
