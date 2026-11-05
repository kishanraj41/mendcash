import { createHash, sign, verify, type KeyObject } from "crypto";

/**
 * Compact JWS with EdDSA (Ed25519). AP2 v0.2 uses SD-JWT verifiable credentials; MendCash uses
 * plain compact JWS with AP2's claim names and hashes the compact serialization, the way AP2
 * computes `checkout_hash` and receipt `reference` values.
 */

export type JwsHeader = { alg: "EdDSA"; typ: string; kid: string };

export function b64url(input: Buffer | Uint8Array | string): string {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input)).toString("base64url");
}

/** base64url(SHA-256(text)). Used for checkout_hash, transaction_id and receipt references. */
export function sha256B64url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

export function sha256Hex(input: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function signJws(payload: object, privateKey: KeyObject, kid: string, typ = "JWT"): string {
  const header: JwsHeader = { alg: "EdDSA", typ, kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput, "ascii"), privateKey))}`;
}

export type DecodedJws<T> = { header: JwsHeader; payload: T; signingInput: string; signature: Buffer };

export function decodeJws<T>(jws: string): DecodedJws<T> {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) throw new Error("Not a compact JWS.");
  return {
    header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as JwsHeader,
    payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as T,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], "base64url"),
  };
}

export function verifyJws(jws: string, publicKey: KeyObject): boolean {
  try {
    const decoded = decodeJws<unknown>(jws);
    if (decoded.header.alg !== "EdDSA") return false;
    return verify(null, Buffer.from(decoded.signingInput, "ascii"), publicKey, decoded.signature);
  } catch {
    return false;
  }
}
