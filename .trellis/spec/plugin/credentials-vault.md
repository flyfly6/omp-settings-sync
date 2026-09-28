# Credentials Vault

> `src/vault.ts` — encrypted sync of session tokens and logins (`auth.json`, `auth-broker.json`).

---

## File Format

`vault.enc` (`.vault.enc` is also read/written for legacy layouts) is JSON:

```jsonc
{
  "version": 1,
  "kdf": "scrypt",
  "salt": "<base64, 16 bytes>",
  "iv": "<base64, 12 bytes>",
  "tag": "<base64, GCM auth tag>",
  "ciphertext": "<base64>"
}
```

- Key derivation: `crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })`.
- Encryption: AES-256-GCM, fresh random salt + IV per write, so re-encryption always changes the bytes; the sensitive-file hash gate (below) is what prevents pointless churn.
- Plaintext payload: `{ updatedAt, files: { "<relative path>": "<file content>" } }`.
- KDF is synchronous by design — the payload is a couple of small files and the code stays linear. It does block the host event loop briefly; making it async is a deliberate change, not a drive-by.

Known gap to respect: `decryptPayload` validates that the cryptographic fields exist and are strings but **does not gate on `version`/`kdf`**. Before introducing a new format or KDF, add version checking and a migration path; otherwise an old build will happily attempt to decrypt a future file and report a wrong-passphrase error.

Error strings are part of the UX: `Corrupt vault file: invalid JSON format`, `Corrupt vault file: missing cryptographic headers`, `Decryption failed: incorrect passphrase or corrupted data`, `Corrupted vault payload: invalid format`. Callers decide how to degrade — `runLink` warns and continues unencrypted, `runSync`/`runReset` ignore a failed refresh, `runUnlockVault` surfaces it.

## The Synced Credential Set

`SYNCABLE_SENSITIVE_FILES = ["auth.json", "auth-broker.json"]` drives **all** of: `packSensitiveFiles`, `unpackSensitiveFiles`, `hashSensitiveFiles`, and the file list in `showStatus`. Add a credential file in one place and all four follow — but also check:

1. The name is denied by `isDenied` (`auth*` covers the current two). A new name must never enter `DEFAULT_ALLOWED_PATHS`.
2. `README.md` "What Syncs Encrypted" list.
3. A case in `test/vault.test.ts`.

`unpackSensitiveFiles` writes each file with mode `0o600` through `atomicWriteFile`, then records the new hash.

## Passphrase Cache

- In-memory `Map<dir, password>` **plus** `.git-sync/vault.key` (mode `0600`), written atomically. `.git-sync/` is denied by the hard denylist, so the cached passphrase never reaches the remote.
- `getVaultStatus(dir)` returns `disabled` (no vault file), `locked` (no cached password, or the cached password fails to decrypt), `unlocked` otherwise. Commands report these three states verbatim in `/ompsync status`.
- `runLockVault` clears both the memory map and the key file; `runEnableVault`/`runUnlockVault`/`runLink` populate them.
- Never print, notify, or return the passphrase, and never place it in `state.json`.

## Change Detection

- `hashSensitiveFiles` = SHA-256 over `rel + ":" + content` for the sorted sensitive set, returning `""` when no file exists.
- The result is stored in `.git-sync/sensitive.hash` (`saveSensitiveHash`).
- `hasSensitiveChanges` is the single "are local credentials newer than the vault?" answer. It self-heals: with no saved hash but an existing vault it decrypts the payload, hashes the payload files the same way, and — if they match the current files — persists the hash and reports no change.
- Vault re-encryption happens exactly once per sync cycle, inside `prepareCommit`, gated by vault status `unlocked` **and** `hasSensitiveChanges` **and** a non-empty payload. `runEnableVault` and `runUnlockVault` write it directly because the user just supplied the passphrase.

## Lifecycle

| Command | Effect |
| :--- | :--- |
| `runInit(..., { password })` | Packs + encrypts + caches + hashes before the first commit |
| `runLink` | If `vault.enc` arrived from the remote: prompt (optional) → decrypt → restore → cache; wrong passphrase or blank input warns and continues with unencrypted config |
| `runEnableVault(password)` | Pack → encrypt → write → cache → hash → commit + push when the repo is syncable |
| `runDisableVault` | Delete `vault.enc` (and `.vault.enc`), clear the cache, `git rm -f vault.enc`, commit + push |
| `runUnlockVault(password?)` | Decrypt + restore + cache; throws when no vault file or no passphrase |
| `runLockVault` | Clear cache only; `vault.enc` stays in the repo |

Because the vault is a normal allowlisted file, a merge conflict on `vault.enc` is possible; `showStatus` prints explicit `git checkout --theirs vault.enc` / `--ours` instructions for it rather than the generic conflict advice.
