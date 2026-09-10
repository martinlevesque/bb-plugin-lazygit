// lib/base64.ts — base64 codec shared by the backend (node) and frontend
// (browser). Both runtimes provide atob/btoa and the Text* encoders, so one
// implementation covers the RPC wire format: output chunks and keystrokes.
// Each function is byte-exact: the lazygit stream is UTF-8 text but may
// contain partial multibyte sequences at chunk boundaries, which is why the
// panel writes raw bytes (`decodeBase64Bytes`) rather than decoding to a
// string first.

/** Encode a string as base64 using its UTF-8 bytes. */
export function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode a base64 string to the raw bytes it encodes. */
export function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Decode a base64 string to its UTF-8 text. */
export function decodeBase64ToUtf8(value: string): string {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}