/**
 * PKCE (Proof Key for Code Exchange) Utility Helpers
 */

/**
 * Generate a random string for the code verifier
 * @param {number} length
 * @returns {string}
 */
export const generateCodeVerifier = () => {
  const array = new Uint32Array(56 / 2);
  window.crypto.getRandomValues(array);
  return Array.from(array, dec => ('0' + dec.toString(16)).slice(-2)).join('');
};

/**
 * Generate a SHA-256 hash of the input string
 * @param {string} plain
 * @returns {Promise<ArrayBuffer>}
 */
async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest('SHA-256', data);
}

/**
 * Base64-urlencode the input
 * @param {ArrayBuffer} str
 * @returns {string}
 */
function base64urlencode(str) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate the code challenge from the code verifier
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export const generateCodeChallenge = async (verifier) => {
  const hashed = await sha256(verifier);
  return base64urlencode(hashed);
};
