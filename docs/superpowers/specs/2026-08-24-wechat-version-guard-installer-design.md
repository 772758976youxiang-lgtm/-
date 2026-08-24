# WeChat 4.1.10.27 Version Guard and Installer Design

Date: 2026-08-24

## Status

Approved approach: backend-enforced version gate with one in-app confirmation, one UAC elevation when required, unattended installation, post-install verification, and automatic update suppression.

## Problem

The personal WeChat channel depends on Windows WeChat `4.1.10.27`. The current switch enables the channel without checking the installed WeChat version. Running the integration against an incompatible WeChat build can fail and may increase account restriction or ban risk.

The plugin must therefore refuse to enable the channel unless the selected Windows WeChat 4.x executable is exactly `4.1.10.27`. If another version is present, the UI must warn the user and offer to install the required version. Declining installation leaves the switch off. Accepting installation authorizes the plugin to download, verify, install, and suppress automatic updates with no additional plugin confirmation. Windows may still display one UAC prompt.

The implementation must work across Windows devices, users, drive letters, and custom installation directories. It must not rely on this development machine's paths.

## Goals

- Enforce exact installed executable version `4.1.10.27` before enabling or starting the channel.
- Show a clear compatibility and account-risk warning when the version is missing or incompatible.
- Keep the switch off if the user declines installation or any installation step fails.
- Download the requested installer from a pinned URL and verify its size, SHA-256, and Authenticode signature before execution.
- Install unattended after one in-app confirmation, requesting UAC only when Windows requires elevation.
- Dynamically discover the actual WeChat 4.x installation and updater paths.
- Suppress automatic updates reversibly, without touching WeChat 3.x, WeCom/WXWork, or unrelated Tencent software.
- Recheck compatibility at plugin startup and whenever the user enables the channel.
- Fail closed: uncertain detection, failed verification, refused UAC, failed installation, or failed update suppression must never enable the channel.

## Non-goals

- Supporting arbitrary WeChat versions.
- Bypassing Windows UAC or hiding the Windows-controlled elevation prompt.
- Deleting chat history, account data, or user profile directories.
- Uninstalling WeChat 3.x or WeCom/WXWork.
- Guaranteeing that Tencent will never introduce a new update mechanism. The exact-version startup guard remains the final safety control if update suppression later becomes ineffective.
- Claiming that an incompatible version guarantees an account ban. The UI describes increased risk rather than certainty.

## Considered Approaches

### A. Backend guard and elevated one-shot helper (selected)

The local plugin server owns discovery, verification, download, installation state, and the enable decision. A narrowly scoped helper receives elevation for the installation and update-suppression steps.

This provides consistent behavior across directories, keeps the security-sensitive work out of the browser UI, and allows the switch to remain fail-closed.

### B. Frontend-driven installation

The settings UI would directly launch shell commands. This has poor privilege handling, exposes more attack surface, and is difficult to make reliable in the browser-hosted plugin environment. Rejected.

### C. Persistent Windows service

A service could perform future maintenance without repeated UAC prompts, but it adds a separate installed component, lifecycle management, and a much larger security surface. Rejected as disproportionate for a one-shot install flow.

## User Experience

### Compatible version

1. The user turns on the WeChat channel.
2. The backend resolves the active WeChat 4.x executable and reads its real file version.
3. If it is exactly `4.1.10.27`, the backend verifies update suppression and enables the channel.

### Missing or incompatible version

1. The user turns on the switch.
2. The backend returns a structured `WECHAT_VERSION_REQUIRED` response. It does not alter the saved enabled state.
3. The UI shows a modal similar to:

   > 检测到的微信版本为 {currentVersion}，微信通道仅支持 4.1.10.27。继续使用其他版本可能导致兼容异常，并增加账号封禁风险。是否安装微信 4.1.10.27？

4. The modal provides:
   - `安装 4.1.10.27`
   - `取消，保持关闭`
5. Cancel closes the modal, keeps the switch off, and leaves a visible warning beneath the channel row.
6. Install consumes the one-time confirmation and begins the unattended job. The UI displays phases such as downloading, verifying, requesting administrator permission, installing, disabling updates, verifying, and starting.
7. UAC cancellation or any other failure ends the job, leaves the switch off, and presents an actionable error.
8. Only a complete post-install verification permits the backend to save `enabled: true` and start the channel.

### Version drift after a later update or repair

At server startup, configuration synchronization validates an already-enabled WeChat channel before launching it. If the version has drifted, the backend forces the channel off and exposes the same warning state. The channel process is never started against an unapproved version.

## Windows WeChat Discovery

Discovery returns a structured candidate containing executable path, normalized real path, file version, product metadata, source, install root, and confidence. It never treats a registry `DisplayVersion` or installer filename as authoritative.

Candidate sources, in order of intent and confidence, are:

1. `DSH_WECHAT_EXECUTABLE`, when configured and validated as WeChat 4.x.
2. The executable path of a running `Weixin.exe` process.
3. WeChat/Weixin uninstall records from both HKCU and HKLM, including 32-bit and 64-bit registry views.
4. Environment-derived Program Files and Local AppData locations as a fallback.

Every candidate must exist, resolve to a regular file named `Weixin.exe`, identify as WeChat/Weixin, and have major version 4. `WeChat.exe` and version 3.x records may continue to exist on the same machine but are excluded from this feature.

When several valid 4.x candidates exist, explicit configuration wins, followed by a running process, then a valid uninstall record. If candidates at the same confidence level conflict, discovery returns an ambiguity error instead of choosing silently.

The installed version is the four-part file version of the resolved `Weixin.exe`. The target installer metadata is not used as proof of the installed patch version; discovery must observe `4.1.10.27` after installation.

## Installer Artifact Policy

The artifact is pinned in plugin code:

- URL: `https://github.com/SiverKing/wechat4.0-windows-versions/releases/download/v4.1.10.27/weixin_4.1.10.27.exe`
- Expected size: `239441904` bytes
- SHA-256: `54203fc2b41983fa106b0af0d67f86befc56ccd3dc1005d4bab6de8ea36b4f74`
- Required Authenticode status: valid
- Required signer organization: `Tencent Technology (Shenzhen) Company Limited`

The download implementation:

- Writes to a unique directory under the current user's system temporary directory.
- Streams to disk with a size limit instead of buffering the complete installer in memory.
- Allows HTTPS only and limits redirects to GitHub release asset hosts.
- Rejects an unexpected content length, final size, hash, signature status, or signer.
- Uses the pinned digest in shipped code; it does not trust a mutable remote checksum at install time.
- Cleans temporary artifacts after success or failure, while retaining only minimal non-sensitive diagnostic information.

## Installation and Elevation

The server starts a shipped PowerShell helper using argument-array process spawning and `Start-Process -Verb RunAs -Wait`. No command is assembled through shell string interpolation.

The helper receives only absolute validated paths and a single-use operation file. It performs these bounded actions:

1. Revalidate the installer hash and Authenticode signature in the elevated context.
2. Close `Weixin.exe` and `WeixinUpdate.exe`; do not stop `WeChat.exe`, `WXWork.exe`, or `WXWorkUpgrader`.
3. Launch the installer with the verified unattended option and wait for its exit code.
4. Rediscover WeChat 4.x after the installer exits and verify that the installed `Weixin.exe` is exactly `4.1.10.27`.
5. Apply and verify update suppression against that newly resolved installation root.
6. Return a machine-readable result through a protected temporary result file.

The implementation must prove the unattended installer option in Windows acceptance testing. If the installer does not reliably honor it, the operation fails with a clear error rather than opening an unexpected interactive installer or claiming success.

The target installer is allowed to choose or reuse the installation directory. The plugin does not hardcode a destination and does not separately run an uninstaller or delete application/data directories. If the installer cannot replace a newer version unattended, the operation fails closed and preserves the current installation.

After the helper exits, the non-elevated backend discards previous path assumptions and independently repeats discovery, exact-version validation, and update-suppression validation. This preserves the one-UAC design while avoiding trust in the helper result alone. Installation is successful only when both the helper and backend validations pass.

## Automatic Update Suppression

After its successful post-install version verification, the same elevated helper dynamically scans only the resolved WeChat 4.x install root for exact updater components. The current known layout includes a versioned `WeixinUpdate.exe`, but no version directory is hardcoded. No second elevation is started.

The helper:

1. Stops `WeixinUpdate.exe` processes whose executable paths belong to the resolved WeChat install root.
2. Renames each discovered updater binary to a collision-safe `.dsh-disabled` backup beside the original.
3. Creates or updates a plugin-owned outbound Windows Firewall rule for the original updater path, so a repaired/recreated updater at that path cannot fetch updates.
4. Disables only scheduled tasks or services whose resolved executable path points to the discovered updater inside the selected WeChat root.
5. Records original paths and previous task/service/firewall state in a small plugin state file so the changes can be reversed in a future maintenance command.

The helper must explicitly exclude any component outside the resolved WeChat 4.x root, especially WeChat 3.x and WXWork/WeCom components.

Suppression verification requires:

- No updater process is running from the selected root.
- Every discovered updater binary is disabled or absent.
- The matching firewall block rule exists.
- No matching updater task or service remains enabled.

If suppression cannot be verified, the channel remains off. Startup and enable-time version checks protect against future updater layout changes or installer repair restoring the updater.

## Server State and API

The existing status response gains fields such as:

```json
{
  "installedVersion": "4.1.12.26",
  "targetVersion": "4.1.10.27",
  "versionCompatible": false,
  "updateSuppressed": false,
  "install": {
    "phase": "idle",
    "progress": null,
    "errorCode": null
  }
}
```

### Enable request

`POST /api/wechat/toggle` with `enabled: true` performs discovery first.

- Compatible and update-suppressed: enable normally.
- Incompatible or missing: return HTTP 409 with code `WECHAT_VERSION_REQUIRED`, current/target version, warning text, and a one-time confirmation token. Do not save the enabled state.
- Compatible but update suppression is missing: return an action-required response and use the same confirmed maintenance job before enabling.

Disabling the channel remains immediate and never requires version checks.

### Installation request

`POST /api/wechat/install` accepts the one-time token. Only one installation job may run. The request starts the job and returns the current status; the existing periodic status poll reports progress until completion.

The confirmation token is random, memory-only, short-lived, single-use, and bound to the observed executable/version plus the requested target. If local state changes before consumption, the server rejects it and requires a fresh check.

### Local API protections

Because installation can trigger elevation, mutating WeChat endpoints must:

- Continue binding only to loopback.
- Validate `Host` and permit only expected loopback browser origins.
- Require JSON requests and the one-time token for installation.
- Reject concurrent jobs and replayed tokens.
- Avoid returning installer paths or command details unnecessarily.

## Internal Structure

Platform and installation logic should be extracted from `server.mjs` into a small Windows manager module with dependency injection for filesystem, registry/process execution, download, signature verification, and elevation. `server.mjs` remains responsible for API routing, channel configuration, and lifecycle decisions.

The readable client source and shipped `lib/client.js` bundle must remain behaviorally aligned. The settings component owns only modal/progress presentation; it cannot bypass the backend guard.

## Failure Handling

All failures use stable machine-readable codes and a localized user message. Important cases include:

- `WECHAT_NOT_FOUND`
- `WECHAT_DISCOVERY_AMBIGUOUS`
- `WECHAT_VERSION_REQUIRED`
- `DOWNLOAD_FAILED`
- `INSTALLER_SIZE_MISMATCH`
- `INSTALLER_HASH_MISMATCH`
- `INSTALLER_SIGNATURE_INVALID`
- `UAC_CANCELLED`
- `INSTALL_FAILED`
- `POST_INSTALL_VERSION_MISMATCH`
- `UPDATE_SUPPRESSION_FAILED`
- `INSTALL_ALREADY_RUNNING`

Failure invariants:

- Persisted channel state is disabled.
- No WeChat channel subprocess remains running.
- Temporary installer files are cleaned up.
- Updater suppression is not attempted until target-version installation succeeds.
- Partial updater changes are recorded and reported; they are not hidden as success.

## Testing Strategy

Development follows test-driven development.

### Unit tests

- Candidate discovery across custom drives and directories.
- Coexistence of WeChat 3.x, WeChat 4.x, and WXWork.
- Candidate precedence and ambiguity handling.
- Exact four-part version comparison.
- Download redirect allowlist, size limit, hash verification, signature/signer validation, and cleanup.
- One-time confirmation token expiry, replay rejection, and state binding.
- Job state transitions and concurrency rejection.
- Updater path scoping and explicit WXWork/WeChat 3.x exclusions.
- Every failure path preserves `enabled: false`.

### API and client tests

- Compatible enable path.
- Version-required HTTP 409 response.
- Cancel keeps the visual and persisted switch off.
- Confirm starts one job and progress renders correctly.
- UAC cancellation, download failure, installation failure, and suppression failure display actionable errors.
- Successful completion enables only after final verification.
- Startup disables an already-configured channel after version drift.
- Chinese and English UI strings remain present in the shipped client bundle.

### Windows acceptance tests

- Installer hash and Authenticode verification against the pinned artifact.
- Proven unattended behavior and exit-code handling.
- Existing default install, custom install directory, and fresh install.
- Newer-version replacement behavior without deleting user data.
- Dynamic discovery after the installer changes or reuses a path.
- UAC acceptance and cancellation.
- Update process termination, updater rename, firewall rule, and task/service scoping.
- Reboot/startup check and simulated version drift.

The feature is not complete if unattended installation, exact post-install version detection, or update suppression cannot be demonstrated on Windows.

## Acceptance Criteria

- Turning on the switch with any version other than `4.1.10.27`, or with no WeChat 4.x install, never enables the channel.
- The warning asks whether to install `4.1.10.27` and states that incompatible versions may increase account-ban risk.
- Declining keeps the switch off and leaves a visible warning.
- Accepting requires no second plugin confirmation; Windows may show one UAC prompt.
- The implementation contains no machine-specific drive, user, or install path.
- The pinned installer passes size, hash, and Tencent Authenticode verification before execution.
- The post-install executable reports exactly `4.1.10.27`.
- Update suppression is applied only to the selected WeChat 4.x installation and is verified before enabling.
- Any error, ambiguity, or partial result leaves the channel off.
- Automated tests and Windows acceptance checks pass, and the shipped client bundle matches the readable client source.
