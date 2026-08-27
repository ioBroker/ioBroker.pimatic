# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`iobroker.pimatic` connects a [pimatic](https://pimatic.org/) home automation server to ioBroker. It mirrors pimatic devices, their attributes, actions, variables and groups into ioBroker objects, keeps the values up to date and writes changes back to pimatic.

TypeScript (CommonJS output). Sources live in `src/`, the published and runnable code is the compiled `build/` (`package.json` `main` is `build/main.js`). `build/` is gitignored — always build before starting the adapter or the integration tests.

## Commands

```bash
npm run build                             # tsc -p tsconfig.build.json  -> build/
npm run watch                             # same in watch mode
npm run check                             # type check only (tsconfig.json, noEmit)
npm run lint                              # eslint (@iobroker/eslint-config, flat config)
npx eslint -c eslint.config.mjs --fix src # autofix + prettier formatting

npm run test:package                      # validates package.json / io-package.json / admin JSON (fast)
npm run test:integration                  # starts a real js-controller + adapter instance
npm run release-patch                     # @alcalzone/release-script, moves the README changelog into io-package news
```

`npm ci` / `npm install` runs `prepare` → `npm run build`, so a fresh checkout is runnable without an extra step. The integration test aborts with "JS-Controller is already running!" if a js-controller is running on the machine — that is the environment, not a broken test.

## Architecture

### Layout

| Path | Content |
| --- | --- |
| `src/main.ts` | the whole adapter: one `Pimatic extends utils.Adapter` class |
| `src/lib/types.ts` | shapes of the JSON that the pimatic socket.io API delivers |
| `src/lib/crypto.ts` | legacy XOR credential obfuscation, only used by the password migration |
| `src/lib/adapter-config.d.ts` | augments `ioBroker.AdapterConfig` |
| `admin/jsonConfig.json` | the configuration dialog |
| `admin/i18n/<lang>.json` | flat translations, keys are the English labels from `jsonConfig.json` |

`src/lib/adapter-config.d.ts` is hand-maintained and must be kept in sync with `native` in `io-package.json` **and** with `admin/jsonConfig.json` — nothing generates it. The four keys are `host`, `port`, `username`, `enc_password`.

### Transport

Two channels to the same pimatic server, both built in `connect()`:

- **socket.io** (`socket.io-client` **v2**, do not upgrade — pimatic 0.9 speaks the socket.io 2.x protocol). Credentials go into the URL as query parameters. This is the read path: pimatic pushes `devices`, `variables`, `groups`, `deviceAttributeChanged` and `callResult`. It also emits `rules` and `pages`, which this adapter ignores.
- **HTTP REST** via `axios`, used only to write device attributes: `GET http://<user>:<pass>@<host>/api/device/<deviceId>/<action>?<param>=<value>`. Variables are *not* written this way — they go back over socket.io with an `updateVariable` call.

`this.url`, `this.getUrl` and `this.credentials` are built once (`||=`) and then reused, so a configuration change requires an adapter restart.

### Object model

Everything lands under `<namespace>.devices.`:

| pimatic | ioBroker |
| --- | --- |
| device | channel `devices.<deviceId>` |
| device attribute | state `devices.<deviceId>.<attribute>` (read-only unless an action writes it) |
| action parameter without a matching attribute | state `devices.<deviceId>.<action>.<param>` (write-only) |
| variable | state `devices.<variableName>` |
| group | `enum.pimatic.<groupId>` |

Rules that are easy to break:

- **Object IDs replace whitespace with `_`**, the pimatic name is kept in `native.name` / `native.control.deviceId` because the API needs the original. `syncVariables()` and the `deviceAttributeChanged` handler must build the ID the same way, otherwise updates land on states that do not exist.
- **`native.control`** (`{ action, deviceId }`) is what makes a state writable. `onStateChange()` refuses anything without it, and `syncDevices()` attaches it to an existing attribute state when an action has a parameter of the same name.
- **`common.type` of variables is `mixed`** on purpose: pimatic variables are untyped and the same variable can deliver a number, a string or a boolean.
- Read-only pimatic variables become states with `write: false` and no `native.control`.

### Syncing

`syncObjects()` and `syncStates()` read the current object/state first and only write when something actually changed. Both are sequential `for await` loops — deliberately, so a large pimatic installation does not fire hundreds of parallel writes at js-controller.

`syncObjects()` compares `common` per key with `!==`. For object-valued keys (`states`, `members`) that is always true, so those objects are rewritten on every sync. Harmless, but it explains the write traffic.

### Configuration and the password

`native.enc_password` is listed in `encryptedNative` of `io-package.json`, so js-controller decrypts it before the adapter starts — `this.config.enc_password` is the plain password. `admin/jsonConfig.json` therefore uses a plain `"type": "password"` field **without** `"encrypted": true`; setting both would encrypt twice.

`migratePassword()` handles installations from before 0.4.0, which stored the password unencrypted in `native.password`: it encrypts the value into `native.enc_password`, deletes `native.password` and returns `true`, whereupon the adapter stops and waits for the restart js-controller performs after the instance object changed.

## Known problems

Carried over from the JavaScript version, not fixed during the TypeScript port:

- **`battery` attributes**: `syncDevices()` sets `common.type = 'boolean'` and a `native.mapping` of `{ ok: false, low: true }`, but the state value pushed a few lines earlier is still the raw string `'ok'`/`'low'`, and nothing applies the mapping for device attributes (only `syncVariables()` does). The `attr.value = attr.value !== 'ok'` line runs after `delete attr.value` and therefore always yields `true`. Fixing this means deciding whether existing installations may see their battery states flip from string to boolean.
- **`callResult`**: the handler looks up `this.objects[msg.id]`, but `msg.id` is a pimatic call ID, not an ioBroker object ID, so the branch is effectively dead.

## Conventions

- Adapter-core timers (`this.setTimeout` / `this.setInterval`) only — never the global ones, otherwise they survive an unload.
- No `any`. Data from pimatic gets an interface in `src/lib/types.ts`; genuinely unknown shapes are `unknown` plus a type guard.
- Behaviour changes are separate commits from refactorings, so a diff stays reviewable.
- The changelog lives in `README.md` under `### **WORK IN PROGRESS**`; `common.news` in `io-package.json` is written by the release script, never by hand.
