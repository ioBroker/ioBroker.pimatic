/**
 * Legacy ioBroker credential obfuscation (XOR with the system secret).
 *
 * Only needed to migrate a plain `native.password` of an old installation into the
 * encrypted `native.enc_password`. It must stay byte compatible with js-controller,
 * which decrypts `encryptedNative` attributes with the very same scheme.
 *
 * @param key the secret from `system.config`
 * @param value the plain text value
 */
export function encrypt(key: string, value: string): string {
    let result = '';
    for (let i = 0; i < value.length; ++i) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}
