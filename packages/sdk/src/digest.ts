// Shared hashing and encoding for envelope idempotency and artifact
// commitments. WebCrypto only, so the sdk stays portable to edge runtimes.

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256HexOfJson(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
