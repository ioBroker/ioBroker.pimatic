// Augments the globally declared ioBroker types with everything this adapter adds.
// The attributes of `AdapterConfig` must be kept in sync with `native` in io-package.json
// and with admin/jsonConfig.json.

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** IP address or hostname of the pimatic server */
            host: string;
            /** Port of the pimatic web server */
            port: number;
            /** User of the pimatic server */
            username: string;
            /**
             * Password of the pimatic user.
             *
             * Listed in `encryptedNative` of io-package.json, so js-controller decrypts it
             * before the adapter starts - the value read here is the plain password.
             */
            enc_password: string;
        }
    }
}

// this is required so the above is treated as a module
export {};
