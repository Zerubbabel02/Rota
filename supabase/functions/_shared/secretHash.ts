// Same PBKDF2 hash-and-salt pattern native-biometric-enroll/-verify already
// use for the biometric secret — reused here for OTP codes so neither is
// ever stored in plain text.
export async function hashSecret(secret: string, saltBytes: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 100_000, hash: "SHA-256" }, keyMaterial, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

export function randomSaltB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function saltBytesFromB64(saltB64: string): Uint8Array {
  return Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
}
