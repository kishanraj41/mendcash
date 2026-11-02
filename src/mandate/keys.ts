import { createHash, createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from "crypto";

export type KeyRole = "user" | "agent" | "merchant";

export type DemoKey = {
  role: KeyRole;
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
};

export type DemoKeys = Record<KeyRole, DemoKey> & { seedIsPublic: boolean };

/**
 * Published so anyone can rebuild the replay fixtures. Signatures made with this seed prove
 * integrity, not identity: anyone can sign with it. Set MANDATE_KEY_SEED on a private deployment.
 * In AP2 the user key lives on the buyer's trusted surface (a wallet or passkey), not on the merchant.
 */
export const PUBLIC_DEMO_SEED = "mendcash-public-demo-seed-v1";

// PKCS#8 DER prefix for a raw 32-byte Ed25519 private key (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** RFC 7638 JWK thumbprint for an OKP key. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string }): string {
  return createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url");
}

export function publicKeyFromJwk(jwk: unknown): KeyObject | null {
  if (!jwk || typeof jwk !== "object") return null;
  const record = jwk as Record<string, unknown>;
  if (record.kty !== "OKP" || record.crv !== "Ed25519" || typeof record.x !== "string") return null;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: record.x }, format: "jwk" });
  } catch {
    return null;
  }
}

function derive(seed: string, role: KeyRole): DemoKey {
  const raw = Buffer.from(hkdfSync("sha256", Buffer.from(seed, "utf8"), Buffer.from("mendcash-ap2-demo-keys"), Buffer.from(role), 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const x = (publicKey.export({ format: "jwk" }) as { x?: string }).x;
  if (!x) throw new Error("Could not export the Ed25519 public key.");
  const publicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x };
  return { role, kid: `mc-${role}-${jwkThumbprint(publicJwk).slice(0, 12)}`, privateKey, publicKey, publicJwk };
}

const cache = new Map<string, DemoKeys>();

export function demoKeys(seed: string = PUBLIC_DEMO_SEED): DemoKeys {
  const key = seed || PUBLIC_DEMO_SEED;
  const hit = cache.get(key);
  if (hit) return hit;
  const keys: DemoKeys = {
    user: derive(key, "user"),
    agent: derive(key, "agent"),
    merchant: derive(key, "merchant"),
    seedIsPublic: key === PUBLIC_DEMO_SEED,
  };
  cache.set(key, keys);
  return keys;
}
