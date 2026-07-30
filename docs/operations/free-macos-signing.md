# Free stable macOS signing and updates

Tovi can keep one stable macOS code identity without joining the paid Apple Developer Program. It uses a private self-signed code-signing certificate held by the release owner, a public certificate trusted once by each Mac, and Electron's native macOS updater for every later release.

This is suitable for the small pilot. It is not equivalent to Developer ID signing or Apple notarization.

## What users experience

The first migration from an ad-hoc build is manual because the old build already has a hash-based identity:

1. Install the new DMG over the old Tovi app.
2. Control-click Tovi and choose Open if Gatekeeper blocks the first launch.
3. Choose **Enable seamless updates** when Tovi asks to trust its update certificate.
4. Confirm Full Disk Access once if macOS does not carry the old grant across this migration.

Later updates use the same bundle identifier, signing certificate, and designated requirement. Pressing Update downloads a complete signed app, quits Tovi, replaces it, and relaunches it. The updater never edits files inside the installed signed bundle.

The dev and pilot tracks are still the same `/Applications/Tovi.app`. They differ only in the update feed baked into the signed build. See [Signed macOS dev and pilot channels](macos-release-channels.md).

## Create the identity once

Run:

```bash
scripts/create-free-macos-signing-identity.sh
```

The script creates a ten-year code-signing certificate in `.release-signing/`, installs it in the login keychain, and marks it trusted for code signing. It deletes the temporary unencrypted key after creating the password-protected `.p12`. Keep the `.p12` private and backed up. The `.cer` file contains only the public certificate and is safe to bundle.

Release automation can set `RIOS_SKIP_KEYCHAIN_INSTALL=1` to create the files without changing the login keychain. This is useful when the P12 will first be imported into an isolated build keychain.

Configure these GitHub Actions secrets:

| Secret | Value |
| --- | --- |
| `RIOS_FREE_MACOS_IDENTITY` | `Tovi Free Update Signing` |
| `RIOS_FREE_MACOS_P12_PASSWORD` | The password entered when the identity was created |
| `RIOS_FREE_MACOS_P12_BASE64` | Base64 of `tovi-update-signing.p12` |
| `RIOS_FREE_MACOS_CERT_BASE64` | Base64 of `tovi-update-signing.cer` |

Do not print the private key, P12 contents, password, or their base64 values in logs.

## Publish

The **Publish Free Signed macOS Release** workflow runs automatically:

- a push to `develop` publishes the rolling dev feed;
- a push to `main` publishes the separate rolling pilot feed;
- manual dispatch remains available, but only from `develop` or `main`.

The workflow imports the same identity into a temporary build keychain, builds and verifies the app, creates the DMG and Squirrel update zip, and uploads the JSON feed last so an interrupted publish cannot advertise a missing zip.

The workflow refuses seamless update packaging when the stable identity or public certificate is absent. Local ad-hoc builds remain supported, but they do not enable the native packaged updater.

## Limits and recovery

- Gatekeeper does not automatically trust this app because it is not notarized. The initial Control-click Open step remains unavoidable without Apple's paid Developer ID service.
- Every Mac must trust the public certificate once. This is what gives the free build a stable identity across different code hashes.
- Protect and back up the private key. Losing it requires a new certificate and another one-time migration. A stolen key cannot be revoked through Apple's Developer ID system.
- Never rotate the bundle identifier or signing certificate during routine releases. Either change can make macOS treat Tovi as a different app and can reset privacy grants.
- Never create separate bundle identifiers for dev and pilot unless two separate apps and two separate privacy grants are explicitly intended.
