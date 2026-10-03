#!/bin/bash
# Install Phone Farm.command - double-click this in Finder to install Phone Farm on this Mac.
#
# It does NOT build anything. It downloads the newest published macOS installer (.pkg) from
# this repository's GitHub Releases, checks its SHA-256 checksum, and only then opens it in
# Apple's normal Installer. Nothing is written into this repository folder, and no macOS
# security setting is changed: the download is marked as coming from the Internet so that
# Gatekeeper checks it exactly as it would a browser download.
#
# Requirements: macOS 12 or newer and an Internet connection. Uses only tools that ship with
# macOS (bash 3.2, curl, shasum, xattr, open) - no Node.js, npm, Xcode or Homebrew.
#
# Developers: tests source this file and call the pf_* functions; main only runs when the
# file is executed. Building an installer from source is desktop/scripts/build-macos-installer.sh.

PF_REPO="ER404NF/PF-Software"
PF_GITHUB="https://github.com"
PF_MIN_MACOS_MAJOR=12
PF_TAG_PATTERN='^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
PF_WORK_DIR=""
PF_TAG=""
PF_ASSET=""
PF_EXPECTED_SHA=""
PF_KEEP_WORK_DIR=0

# ------------------------------------------------------------------------- output

pf_say() { printf '%s\n' "$*"; }

pf_cleanup() {
  if [ -n "$PF_WORK_DIR" ] && [ "$PF_KEEP_WORK_DIR" != "1" ] && [ -d "$PF_WORK_DIR" ]; then
    rm -rf "$PF_WORK_DIR"
  fi
}

# Prints a plain-language error, removes anything partially downloaded and exits non-zero.
pf_fail() {
  printf '\nPhone Farm was NOT installed.\n%s\n' "$*" >&2
  PF_KEEP_WORK_DIR=0
  pf_cleanup
  # A Finder-launched Terminal window may be set to close on exit; keep the error readable.
  if [ -t 0 ] && [ -z "${PHONE_FARM_NONINTERACTIVE:-}" ]; then
    printf '\nPress Return to close this window.' >&2
    read -r _ || true
  fi
  exit 1
}

# ----------------------------------------------------------------------- platform

# Prints the CPU architecture to install for: arm64 or x86_64. An Apple-silicon Mac running
# this under Rosetta reports x86_64 from uname, so ask the kernel whether we are translated.
pf_detect_arch() {
  local machine
  machine="$(uname -m 2>/dev/null)"
  if [ "$machine" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    machine="arm64"
  fi
  case "$machine" in
    arm64|x86_64) printf '%s\n' "$machine" ;;
    *) return 1 ;;
  esac
}

pf_arch_label() {
  case "$1" in
    arm64) printf 'Apple silicon (arm64)\n' ;;
    x86_64) printf 'Intel (x86_64)\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

pf_check_macos() {
  if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
    pf_fail "This installer is for macOS. On Windows, download Phone-Farm-Windows.exe from ${PF_GITHUB}/${PF_REPO}/releases/latest"
  fi
  local version major
  version="$(sw_vers -productVersion 2>/dev/null)"
  major="${version%%.*}"
  case "$major" in
    ''|*[!0-9]*) pf_fail "Could not read the macOS version (got \"${version}\")." ;;
  esac
  if [ "$major" -lt "$PF_MIN_MACOS_MAJOR" ]; then
    pf_fail "Phone Farm needs macOS ${PF_MIN_MACOS_MAJOR} (Monterey) or newer. This Mac has macOS ${version}."
  fi
}

# --------------------------------------------------------------------- versions

# "https://github.com/OWNER/REPO/releases/tag/v1.2.3" -> "v1.2.3". Fails on anything else.
pf_tag_from_url() {
  local url="$1" tag
  case "$url" in
    */releases/tag/*) tag="${url##*/releases/tag/}" ;;
    *) return 1 ;;
  esac
  [[ "$tag" =~ $PF_TAG_PATTERN ]] || return 1
  printf '%s\n' "$tag"
}

pf_version_from_tag() {
  [[ "$1" =~ $PF_TAG_PATTERN ]] || return 1
  printf '%s\n' "${1#v}"
}

# Installer file names to look for, best first. The build names unsigned and signed-but-not-
# notarized packages with a visible suffix (see desktop/scripts/build-mac-pkg.cjs); the
# universal package runs on both architectures. There is no Intel-only package.
pf_candidates() {
  local version="$1" arch="$2" kind suffix
  for kind in arm64 universal; do
    if [ "$arch" = "x86_64" ] && [ "$kind" = "arm64" ]; then continue; fi
    for suffix in "" "-NOT-NOTARIZED" "-UNSIGNED"; do
      printf 'Phone-Farm-%s-%s%s.pkg\n' "$version" "$kind" "$suffix"
    done
  done
}

pf_signing_note() {
  case "$1" in
    *-UNSIGNED.pkg) printf 'unsigned\n' ;;
    *-NOT-NOTARIZED.pkg) printf 'not-notarized\n' ;;
    *) printf 'notarized\n' ;;
  esac
}

# Reads the expected SHA-256 for NAME from a checksum file in `shasum -a 256` format
# ("<64 hex>  <name>", one file per line). A one-line sidecar with no name is accepted too.
pf_expected_checksum() {
  local file="$1" name="$2" hash entry lines=0 found=""
  [ -s "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -z "$line" ] && continue
    lines=$((lines + 1))
    hash="${line%%[[:space:]]*}"
    entry="${line#"$hash"}"
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry#\*}"
    entry="${entry#./}"
    if [ "$entry" = "$name" ] || { [ -z "$entry" ] && [ -z "$found" ]; }; then
      found="$hash"
      [ -n "$entry" ] && break
    fi
  done < "$file"
  [ -n "$found" ] || return 1
  [[ "$found" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  printf '%s\n' "$found" | tr 'A-F' 'a-f'
}

pf_sha256() {
  local out
  out="$(shasum -a 256 "$1" 2>/dev/null)" || return 1
  printf '%s\n' "${out%%[[:space:]]*}" | tr 'A-F' 'a-f'
}

# -------------------------------------------------------------------------- network

pf_curl() {
  curl --silent --show-error --location --fail --connect-timeout 15 --retry 3 --retry-delay 2 "$@"
}

# Turns a curl exit status into something a person can act on.
pf_network_message() {
  case "$1" in
    5|6|7) printf 'Unable to reach GitHub. Check your Internet connection and try again.\n' ;;
    28) printf 'GitHub did not answer in time. Check your Internet connection and try again.\n' ;;
    35|51|53|54|58|59|60|77|80|83|90|91) printf 'A secure connection to GitHub could not be established. Check that this Mac'"'"'s date and time are correct, and any proxy or firewall, then try again.\n' ;;
    18|56|92) printf 'The download was interrupted before it finished. Try again.\n' ;;
    22) printf 'GitHub refused the request.\n' ;;
    23) printf 'The download could not be saved (is the disk full?).\n' ;;
    *) printf 'The download failed (curl error %s). Try again.\n' "$1" ;;
  esac
}

pf_check_connectivity() {
  local status
  pf_curl --head --max-time 30 --output /dev/null "${PF_GITHUB}/" 2>/dev/null
  status=$?
  [ "$status" -eq 0 ] && return 0
  pf_fail "$(pf_network_message "$status")"
}

# Sets PF_TAG to the newest published (non-draft, non-pre-release) release: the same
# release the app's own update check uses.
pf_resolve_latest_tag() {
  local effective status
  effective="$(pf_curl --max-time 60 --output /dev/null --write-out '%{url_effective}' "${PF_GITHUB}/${PF_REPO}/releases/latest" 2>/dev/null)"
  status=$?
  if [ "$status" -eq 22 ]; then
    pf_fail "No Phone Farm release has been published yet at ${PF_GITHUB}/${PF_REPO}/releases"
  elif [ "$status" -ne 0 ]; then
    pf_fail "$(pf_network_message "$status")"
  fi
  PF_TAG="$(pf_tag_from_url "$effective")" || pf_fail "Could not work out the latest Phone Farm version from GitHub (${effective:-no answer})."
}

# Downloads URL to DEST through a .part file, so a failed or interrupted transfer never
# leaves something that looks like a finished file. Returns curl's status.
pf_download() {
  local url="$1" dest="$2" status
  rm -f "$dest" "$dest.part"
  pf_curl --max-time "${3:-1800}" --output "$dest.part" "$url" 2>/dev/null
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$dest.part"
    return "$status"
  fi
  mv -f "$dest.part" "$dest" || return 23
}

# Does the release contain this file? (One-byte ranged download: cheap and HEAD-free.)
pf_asset_exists() {
  pf_curl --max-time 60 --range 0-0 --output /dev/null "$1" 2>/dev/null
}

# Picks the installer and its checksum. Sets PF_ASSET and PF_EXPECTED_SHA.
pf_select_asset() {
  local tag="$1" arch="$2" version base name status sums="" missing_sum=""
  version="$(pf_version_from_tag "$tag")" || pf_fail "The latest release tag \"${tag}\" is not a version number."
  base="${PF_GITHUB}/${PF_REPO}/releases/download/${tag}"
  PF_ASSET=""
  PF_EXPECTED_SHA=""

  pf_download "${base}/SHA256SUMS.txt" "$PF_WORK_DIR/SHA256SUMS.txt" 120
  status=$?
  if [ "$status" -eq 0 ]; then
    sums="$PF_WORK_DIR/SHA256SUMS.txt"
  elif [ "$status" -ne 22 ]; then
    pf_fail "$(pf_network_message "$status")"
  fi

  for name in $(pf_candidates "$version" "$arch"); do
    pf_download "${base}/${name}.sha256" "$PF_WORK_DIR/${name}.sha256" 120
    status=$?
    if [ "$status" -eq 0 ]; then
      PF_EXPECTED_SHA="$(pf_expected_checksum "$PF_WORK_DIR/${name}.sha256" "$name")" ||
        pf_fail "The published checksum file ${name}.sha256 is not valid. The installer was not opened."
      PF_ASSET="$name"
      return 0
    elif [ "$status" -ne 22 ]; then
      pf_fail "$(pf_network_message "$status")"
    fi
    if [ -n "$sums" ] && PF_EXPECTED_SHA="$(pf_expected_checksum "$sums" "$name")"; then
      PF_ASSET="$name"
      return 0
    fi
    if [ -z "$missing_sum" ] && pf_asset_exists "${base}/${name}"; then
      missing_sum="$name"
    fi
  done

  if [ -n "$missing_sum" ]; then
    pf_fail "Release ${tag} contains ${missing_sum} but no SHA-256 checksum for it, so its integrity cannot be verified. The installer was not opened. Ask the maintainer to re-publish the release with its .sha256 file."
  fi
  if [ "$arch" = "x86_64" ]; then
    pf_fail "Phone Farm ${version} has no installer for Intel Macs. Intel Macs need the universal package, which this release does not include. Apple-silicon Macs are supported."
  fi
  pf_fail "Phone Farm ${version} (the latest release) does not include a macOS installer yet. See ${PF_GITHUB}/${PF_REPO}/releases/tag/${tag}"
}

# ---------------------------------------------------------------------------- main

pf_main() {
  local arch tag version pkg actual status level

  pf_say "Phone Farm Installer"
  pf_say "--------------------"
  pf_say "Checking your Mac..."
  pf_check_macos
  arch="$(pf_detect_arch)" || pf_fail "This Mac's processor ($(uname -m 2>/dev/null)) is not supported. Phone Farm runs on Apple-silicon and Intel Macs."
  pf_say "  $(pf_arch_label "$arch"), macOS $(sw_vers -productVersion 2>/dev/null)"

  PF_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/phone-farm-installer.XXXXXX")" || pf_fail "Could not create a temporary folder for the download."
  trap pf_cleanup EXIT
  trap 'pf_fail "Cancelled."' INT TERM HUP

  pf_say "Checking your Internet connection..."
  pf_check_connectivity

  pf_say "Checking for latest release..."
  pf_resolve_latest_tag
  tag="$PF_TAG"
  version="$(pf_version_from_tag "$tag")"
  pf_select_asset "$tag" "$arch"
  pf_say "  Phone Farm ${version}: ${PF_ASSET}"

  pf_say "Downloading Phone Farm..."
  pkg="$PF_WORK_DIR/$PF_ASSET"
  pf_download "${PF_GITHUB}/${PF_REPO}/releases/download/${tag}/${PF_ASSET}" "$pkg"
  status=$?
  [ "$status" -eq 0 ] || pf_fail "$(pf_network_message "$status")"
  [ -s "$pkg" ] || pf_fail "The downloaded installer is empty. Try again."

  pf_say "Verifying package..."
  actual="$(pf_sha256 "$pkg")" || pf_fail "Could not compute the installer's checksum. The installer was not opened."
  if [ "$actual" != "$PF_EXPECTED_SHA" ]; then
    rm -f "$pkg"
    pf_fail "INTEGRITY CHECK FAILED: the downloaded installer does not match its published SHA-256 checksum.
  expected ${PF_EXPECTED_SHA}
  got      ${actual}
The file was deleted and the installer was not opened. Try again; if this keeps happening, do not install and tell the maintainer."
  fi
  pf_say "  SHA-256 OK"

  # Mark the file the way a web browser would, so Gatekeeper performs its normal checks.
  xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Phone Farm Installer;" "$pkg" 2>/dev/null ||
    pf_fail "Could not mark the download for Gatekeeper checking. The installer was not opened."

  pf_say "Opening installer..."
  PF_KEEP_WORK_DIR=1 # Installer.app reads the package after `open` returns; keep it.
  open "$pkg" || { PF_KEEP_WORK_DIR=0; pf_fail "macOS could not open the installer package."; }

  pf_say ""
  pf_say "Phone Farm installer opened successfully. Follow the macOS Installer steps."
  level="$(pf_signing_note "$PF_ASSET")"
  if [ "$level" != "notarized" ]; then
    pf_say ""
    pf_say "NOTE: this is a DEVELOPMENT build that is not signed and notarized by Apple (${level})."
    pf_say "If macOS says it cannot be opened, open System Settings > Privacy & Security and"
    pf_say "click \"Open Anyway\" for ${PF_ASSET}, or Control-click the package and choose Open."
  fi
  pf_say "(The downloaded package is in ${PF_WORK_DIR}; macOS removes it automatically.)"
  pf_say "You can close this window."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  set -o pipefail
  pf_main "$@"
fi
