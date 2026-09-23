# Releasing the macOS installer (maintainers)

End users download **one file** from GitHub Releases and double-click it:

```text
https://github.com/ER404NF/PF-Software/releases/latest   ->   Phone-Farm-macOS.pkg
```

They never clone the repository, install Node.js, run npm, open Terminal, or run tests. Tests gate the
**release**, not the installation:

```text
source -> GitHub Actions (macOS runner) -> tests -> audits -> build .app -> sign/notarize/staple
       -> build .pkg -> sign/notarize/staple -> verify -> install-test -> GitHub Release -> user
```

## Before you push: check that GitHub will be able to build it

```sh
cd desktop
npm run check:release
```

It reports, in plain language, everything about the installer that can be verified without a Mac: every needed file exists,
is not git-ignored and is committed; `git add -A` would not push a key, an account file or `node_modules`; the workflows
parse and name real scripts; every module the app loads is in its package list; the lockfiles match; the build plan is
complete. **WARN** on "committed" means the installer files are not committed yet — GitHub builds only what was pushed.
The same checks run in the desktop test suite. Add `-- --tests` to also run both full suites. It cannot prove the `.pkg`
builds or installs; only the workflow below (and a real Mac) can.

## Get a first installer to try (no tag, no Apple certificates)

1. Commit everything (`npm run check:release` says what is left) and push to `main`.
2. On GitHub open **Actions > macOS installer** and the newest run. The build takes roughly 15-30 minutes: it runs both test
   suites, the audits, builds the app, builds the package, installs it on a clean Mac runner and boots the installed server.
3. When it is green, scroll to **Artifacts** and download **phone-farm-pkg-arm64** (a zip containing
   `Phone-Farm-<version>-arm64-UNSIGNED.pkg`). Artifacts are kept for 30 days.
4. Unzip it and double-click the `.pkg`. Because it is not signed, macOS says it cannot be opened: **Control-click > Open**, or
   allow it under **System Settings > Privacy & Security > Open Anyway**. This warning goes away once the Apple certificates
   below are configured.
5. Which file: `arm64` is for Apple silicon Macs (any Mac mini from late 2020 on). An older Intel Mac needs the `universal`
   package, which is built on tagged releases or with **Run workflow > universal**. Apple menu > About This Mac says which chip.

If the run is red, open the failing step: a red **Server test suite** or **Desktop tests** step points at a test, a red
**Build, sign, notarize and verify** step prints the failing command. Send the log (or **Help > Copy Diagnostics** from the app
if it is the app that misbehaves).

## Publish a release

1. Set the version in `desktop/package.json` (e.g. `0.2.0`) and commit.
2. Tag exactly `v` + that version and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. `.github/workflows/mac-installer.yml` runs. It fails if the tag and `desktop/package.json` disagree.
4. On success the signed/notarized Release **Phone Farm v0.2.0** contains the stable download
   `Phone-Farm-macOS.pkg`, versioned architecture packages (universal is best effort), and
   `SHA256SUMS.txt`. The Windows workflow adds `Phone-Farm-Windows.exe` to the same release.
   An explicitly allowed unsigned prerelease keeps only its clearly marked `-UNSIGNED` or
   `-NOT-NOTARIZED` filename; it never receives the stable macOS alias.

Branch pushes and pull requests build and verify the same way but publish nothing (the package is an
Actions artifact for 30 days). **Run workflow** (manual) can also build the universal package.

## One-time setup: Apple credentials (repository → Settings → Secrets and variables → Actions)

Without these the workflow still runs, but the package is built `-UNSIGNED` and a **tagged release fails**
(set the repository *variable* `ALLOW_UNSIGNED_RELEASE` to `true` to publish a clearly named, pre-release
`-UNSIGNED` package instead — Gatekeeper will warn users).

| Secret | What |
|---|---|
| `MACOS_APP_CERT_P12_BASE64`, `MACOS_APP_CERT_PASSWORD` | **Developer ID Application** certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MACOS_INSTALLER_CERT_P12_BASE64`, `MACOS_INSTALLER_CERT_PASSWORD` | **Developer ID Installer** certificate, same way |
| `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key for notarization (preferred) |
| *or* `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID notarization (the password is passed to `notarytool` as `@env:`, never on a command line) |

Both Developer ID certificates come from the Apple Developer Program (Certificates, Identifiers & Profiles).
No credential is stored in the repository; the workflow imports the certificates into a temporary keychain
that is deleted at the end.

## What the workflow verifies

- full server suite (run under `TZ=Asia/Tokyo` — neither the California scheduling default nor UTC — so timezone assumptions fail loudly), desktop suite;
- `npm audit --omit=dev` and `desktop/scripts/audit-gate.cjs` for `system/` and `desktop/`;
- the packaged runtime: dependencies resolve, forbidden files absent, server boots, bundle unmodified;
- signed builds: `codesign --verify --deep --strict`, `pkgutil --check-signature`, `spctl --assess`,
  `stapler validate`;
- the finished `.pkg` is expanded (install location `/Applications`, version, bundle id, architecture
  restriction, wizard pages, bundled WDA), **installed with macOS Installer**, and the installed app's server
  is booted from `/Applications/Phone Farm.app`.

It cannot test real iPhones. That remains manual: [MAC_INSTALLER_ACCEPTANCE.md](MAC_INSTALLER_ACCEPTANCE.md).

## Updating bundled WebDriverAgent

Edit `desktop/wda.lock.json` (tag, version and the exact 40-character commit), review the upstream diff and
license, and rebuild. `prepare-wda.cjs` refuses a tag that does not resolve to the pinned commit.

## Local build (developers)

`cd desktop && npm ci && npm test && npm run dist:mac` on a Mac (unsigned unless credentials are in the
environment; see `desktop/README.md`). These maintainer commands are intentionally kept inside `desktop/`;
there are no installer-looking build commands at repository root.
