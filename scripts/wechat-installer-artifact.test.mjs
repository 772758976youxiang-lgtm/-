import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createArtifactManager,
  parseX500SignerOrganization,
  readAuthenticodeSignature,
} from "../wechat-installer-artifact.mjs";
import { WechatControlError } from "../wechat-version-policy.mjs";

const signerOrganization = "Tencent Technology (Shenzhen) Company Limited";

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-artifact-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function webBody(chunks = []) {
  const queue = chunks.map((chunk) => Buffer.from(chunk));
  return new ReadableStream({
    pull(controller) {
      if (queue.length === 0) {
        controller.close();
        return;
      }
      controller.enqueue(queue.shift());
    },
  });
}

function response(status, body = "", headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: body instanceof ReadableStream ? body : webBody([body]),
  };
}

function policyFor(body, url = "https://github.com/org/repo/releases/file.exe") {
  const bytes = Buffer.from(body);
  return {
    url,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    signerOrganization,
  };
}

async function directoryEntries(root) {
  return fs.readdir(root);
}

test("allows only HTTPS requests to the pinned download host set", async (t) => {
  const root = await createRoot(t);
  const manager = createArtifactManager({ tempRoot: root });
  assert.equal(manager.isAllowedUrl(new URL("https://github.com/org/repo/releases/file.exe")), true);
  assert.equal(manager.isAllowedUrl(new URL("https://objects.githubusercontent.com/file.exe")), true);
  assert.equal(manager.isAllowedUrl(new URL("https://release-assets.githubusercontent.com/file.exe")), true);
  assert.equal(manager.isAllowedUrl(new URL("http://github.com/file.exe")), false);
  assert.equal(manager.isAllowedUrl(new URL("https://example.com/file.exe")), false);
  await assert.rejects(
    manager.verifyFile(path.join(root, "missing.exe"), { size: 1, sha256: "0".repeat(64) }),
  );
});

test("accepts only matching size, SHA-256, and Tencent signature", async (t) => {
  const root = await createRoot(t);
  const file = path.join(root, "installer.exe");
  await fs.writeFile(file, "verified fixture");
  const validSignature = { status: "Valid", signerOrganization };
  const manager = createArtifactManager({ tempRoot: root, readSignature: async () => validSignature });
  const digest = crypto.createHash("sha256").update("verified fixture").digest("hex");
  const policy = { size: 16, sha256: digest, signerOrganization };

  await assert.doesNotReject(manager.verifyFile(file, policy));
  await assert.rejects(manager.verifyFile(file, { ...policy, size: 15 }), { code: "INSTALLER_SIZE_MISMATCH" });
  await assert.rejects(manager.verifyFile(file, { ...policy, sha256: "f".repeat(64) }), { code: "INSTALLER_HASH_MISMATCH" });

  const invalidStatus = createArtifactManager({ readSignature: async () => ({ ...validSignature, status: "NotSigned" }) });
  await assert.rejects(invalidStatus.verifyFile(file, policy), { code: "INSTALLER_SIGNATURE_INVALID" });
  const invalidSigner = createArtifactManager({ readSignature: async () => ({ ...validSignature, signerOrganization: "Other" }) });
  await assert.rejects(invalidSigner.verifyFile(file, policy), { code: "INSTALLER_SIGNATURE_INVALID" });
});

test("rejects directories as invalid installer files", async (t) => {
  const root = await createRoot(t);
  const body = "verified fixture";
  const policy = policyFor(body);
  const validSignature = async () => ({ status: "Valid", signerOrganization });
  const manager = createArtifactManager({ readSignature: validSignature });

  await assert.rejects(manager.verifyFile(root, policy), { code: "INSTALLER_FILE_INVALID" });
});

test("rejects symbolic links as invalid installer files", async (t) => {
  const root = await createRoot(t);
  const body = "verified fixture";
  const policy = policyFor(body);
  const validSignature = async () => ({ status: "Valid", signerOrganization });
  const target = path.join(root, "target.exe");
  const link = path.join(root, "link.exe");
  await fs.writeFile(target, body);
  try {
    await fs.symlink(target, link, "file");
    const manager = createArtifactManager({ readSignature: validSignature });
    await assert.rejects(manager.verifyFile(link, policy), { code: "INSTALLER_FILE_INVALID" });
  } catch (error) {
    if (!new Set(["EACCES", "EPERM", "ENOTSUP"]).has(error?.code)) throw error;
    const injectedManager = createArtifactManager({
      readSignature: validSignature,
      lstatImpl: async (file, options) => file === link
        ? {
            isFile: () => true,
            isSymbolicLink: () => true,
          }
        : fs.lstat(file, options),
    });
    await assert.rejects(injectedManager.verifyFile(link, policy), { code: "INSTALLER_FILE_INVALID" });
  }
});

test("rejects a same-size replacement made during signature verification", async (t) => {
  const root = await createRoot(t);
  const body = "same-size installer";
  const file = path.join(root, "installer.exe");
  const displaced = path.join(root, "installer-before-signature.exe");
  await fs.writeFile(file, body);
  const manager = createArtifactManager({
    readSignature: async (signaturePath) => {
      await fs.rename(signaturePath, displaced);
      await fs.writeFile(signaturePath, body);
      return { status: "Valid", signerOrganization };
    },
  });

  await assert.rejects(manager.verifyFile(file, policyFor(body)), { code: "INSTALLER_FILE_CHANGED" });
});

test("binds managed verification to the exact file in the exact active allocation", async (t) => {
  const root = await createRoot(t);
  const body = "fixture";
  const policy = policyFor(body);
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async () => response(200, body),
    readSignature: async () => ({ status: "Valid", signerOrganization }),
  });
  const artifact = await manager.download(policy);
  t.after(() => manager.cleanup(artifact.directory));
  const options = { allocationDirectory: artifact.directory };

  await assert.doesNotReject(manager.verifyFile(artifact.file, policy, options));

  await t.test("rejects a sibling", async () => {
    const sibling = path.join(root, "sibling.exe");
    await fs.writeFile(sibling, body);
    await assert.rejects(manager.verifyFile(sibling, policy, options), { code: "INSTALLER_FILE_INVALID" });
  });

  await t.test("rejects path traversal syntax", async () => {
    const traversal = `${artifact.directory}${path.sep}nested${path.sep}..${path.sep}${path.basename(artifact.file)}`;
    await assert.rejects(manager.verifyFile(traversal, policy, options), { code: "INSTALLER_FILE_INVALID" });
  });

  await t.test("rejects an untracked managed-mode directory", async () => {
    const externalDirectory = await fs.mkdtemp(path.join(root, "external-"));
    const externalFile = path.join(externalDirectory, "installer.exe");
    await fs.writeFile(externalFile, body);
    await assert.rejects(
      manager.verifyFile(externalFile, policy, { allocationDirectory: externalDirectory }),
      { code: "INSTALLER_FILE_INVALID" },
    );
  });
});

test("supports external read-only verification without granting cleanup authority", async (t) => {
  const root = await createRoot(t);
  const externalDirectory = await fs.mkdtemp(path.join(root, "acceptance-"));
  const file = path.join(externalDirectory, "installer.exe");
  const body = "external acceptance fixture";
  await fs.writeFile(file, body);
  const manager = createArtifactManager({
    readSignature: async () => ({ status: "Valid", signerOrganization }),
  });

  await assert.doesNotReject(manager.verifyFile(file, policyFor(body)));
  await assert.rejects(manager.cleanup(externalDirectory), { code: "INSTALLER_CLEANUP_NOT_ALLOWED" });
  assert.equal(await fs.readFile(file, "utf8"), body);
});

test("follows approved redirects manually and atomically publishes an exact download", async (t) => {
  const root = await createRoot(t);
  const body = "verified fixture";
  const policy = policyFor(body);
  const requests = [];
  const progress = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return response(302, "", { location: "https://objects.githubusercontent.com/release/file.exe" });
    }
    return response(200, body);
  };
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl,
    readSignature: async () => ({ status: "Valid", signerOrganization }),
  });

  const artifact = await manager.download(policy, (received, total) => progress.push([received, total]));
  assert.equal(await fs.readFile(artifact.file, "utf8"), body);
  assert.deepEqual(requests.map(({ url }) => url), [
    policy.url,
    "https://objects.githubusercontent.com/release/file.exe",
  ]);
  assert.equal(requests.every(({ options }) => options.redirect === "manual"), true);
  assert.deepEqual(progress.at(-1), [policy.size, policy.size]);
  assert.deepEqual(await fs.readdir(artifact.directory), ["weixin_4.1.10.27.exe"]);
});

test("rejects an unapproved redirect before requesting it and removes the temporary directory", async (t) => {
  const root = await createRoot(t);
  const requests = [];
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return response(302, "", { location: "https://example.com/installer.exe" });
    },
    readSignature: async () => assert.fail("signature must not be read"),
  });

  await assert.rejects(manager.download(policyFor("fixture")), { code: "INSTALLER_URL_NOT_ALLOWED" });
  assert.deepEqual(requests, ["https://github.com/org/repo/releases/file.exe"]);
  assert.deepEqual(await directoryEntries(root), []);
});

test("allows no more than five redirects and cleans up the partial artifact", async (t) => {
  const root = await createRoot(t);
  let requests = 0;
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async () => {
      requests += 1;
      return response(302, "", { location: `https://github.com/redirect-${requests}.exe` });
    },
  });

  await assert.rejects(manager.download(policyFor("fixture")), { code: "INSTALLER_REDIRECT_LIMIT" });
  assert.equal(requests, 6);
  assert.deepEqual(await directoryEntries(root), []);
});

test("rejects oversized and truncated downloads without leaving partial files", async (t) => {
  for (const [label, body] of [["oversized", "fixture!"], ["truncated", "fix"]]) {
    await t.test(label, async () => {
      const root = await createRoot(t);
      const policy = policyFor("fixture");
      const manager = createArtifactManager({
        tempRoot: root,
        fetchImpl: async () => response(200, body),
        readSignature: async () => assert.fail("signature must not be read"),
      });
      await assert.rejects(manager.download(policy), { code: "INSTALLER_SIZE_MISMATCH" });
      assert.deepEqual(await directoryEntries(root), []);
    });
  }
});

test("removes the downloaded artifact when digest or signer verification fails", async (t) => {
  for (const [label, policyOverride, signature, code] of [
    ["digest", { sha256: "f".repeat(64) }, { status: "Valid", signerOrganization }, "INSTALLER_HASH_MISMATCH"],
    ["signer", {}, { status: "Valid", signerOrganization: "Other" }, "INSTALLER_SIGNATURE_INVALID"],
  ]) {
    await t.test(label, async () => {
      const root = await createRoot(t);
      const body = "fixture";
      const manager = createArtifactManager({
        tempRoot: root,
        fetchImpl: async () => response(200, body),
        readSignature: async () => signature,
      });
      await assert.rejects(manager.download({ ...policyFor(body), ...policyOverride }), { code });
      assert.deepEqual(await directoryEntries(root), []);
    });
  }
});

test("reads Authenticode status and certificate organization with a separate encoded path argument", async () => {
  const executable = "C:\\Program Files\\Tencent\\微信\\weixin_4.1.10.27.exe";
  let invocation;
  const signature = await readAuthenticodeSignature(executable, {
    runPowerShell: async (command, args, options) => {
      invocation = { command, args, options };
      return JSON.stringify({ Status: "Valid", Subject: "CN=Tencent, O=Tencent Technology (Shenzhen) Company Limited, C=CN" });
    },
  });

  assert.deepEqual(signature, { status: "Valid", signerOrganization });
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.args[3].includes(executable), false);
  assert.equal(invocation.args[4], Buffer.from(executable, "utf16le").toString("base64"));
  assert.match(invocation.args[3], /FromBase64String/);
  assert.match(invocation.args[3], /\$PSHOME/);
  assert.match(invocation.args[3], /Microsoft\.PowerShell\.Security\.psd1/);
  assert.deepEqual(invocation.options, { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
});

test("parses exactly one X.500 organization across escaped, quoted, and multi-valued subjects", () => {
  const cases = [
    ["CN=Tencent\\, Inc., O=Tencent Technology (Shenzhen) Company Limited, C=CN", signerOrganization],
    ["CN=Signer, O=Tencent\\+Technology\\=Shenzhen, C=CN", "Tencent+Technology=Shenzhen"],
    ["CN=Signer, O=\"Tencent, Technology + Shenzhen = Company\", C=CN", "Tencent, Technology + Shenzhen = Company"],
    ["CN=Signer+O=Tencent Technology (Shenzhen) Company Limited, C=CN", signerOrganization],
    ["CN=Signer, 2.5.4.10=Tencent Technology (Shenzhen) Company Limited, C=CN", signerOrganization],
  ];

  for (const [subject, expected] of cases) {
    assert.equal(parseX500SignerOrganization(subject), expected, subject);
  }
});

test("parses a hex escape immediately followed by a non-hex escape", () => {
  assert.equal(
    parseX500SignerOrganization("CN=Signer, O=Tencent\\2C\\+Technology, C=CN"),
    "Tencent,+Technology",
  );
});

test("rejects duplicate or multiple X.500 organization attributes", () => {
  const subjects = [
    `O=${signerOrganization}, O=${signerOrganization}`,
    `O=${signerOrganization}+2.5.4.10=${signerOrganization}, C=CN`,
    `O=Attacker, CN=Signer, 2.5.4.10=${signerOrganization}`,
  ];

  for (const subject of subjects) {
    assert.throws(
      () => parseX500SignerOrganization(subject),
      { code: "INSTALLER_SIGNATURE_INVALID" },
      subject,
    );
  }
});

test("does not treat deceptive attribute ordering or embedded O text as the signer organization", async (t) => {
  assert.equal(
    parseX500SignerOrganization(`CN=O=${signerOrganization}, OU=${signerOrganization}, O=Attacker`),
    "Attacker",
  );
  const root = await createRoot(t);
  const file = path.join(root, "installer.exe");
  await fs.writeFile(file, "verified fixture");
  const filePolicy = policyFor("verified fixture");
  const manager = createArtifactManager({
    readSignature: async () => ({
      status: "Valid",
      signerOrganization: parseX500SignerOrganization(`CN=O=${signerOrganization}, O=Attacker`),
    }),
  });
  await assert.rejects(manager.verifyFile(file, filePolicy), { code: "INSTALLER_SIGNATURE_INVALID" });
});

test("rejects malformed X.500 signer subjects and subjects without exactly one organization", () => {
  const subjects = [
    "",
    "CN=Signer, OU=Tencent",
    "CN=Signer, O=\"unterminated",
    "CN=Signer, O=trailing\\",
    "CN=Signer,,O=Tencent",
    "CN=Signer+O=Tencent+",
    "CN=Signer, O",
  ];

  for (const subject of subjects) {
    assert.throws(
      () => parseX500SignerOrganization(subject),
      { code: "INSTALLER_SIGNATURE_INVALID" },
      subject,
    );
  }
});

test("cleans up successful artifacts once and rejects untracked directories", async (t) => {
  const root = await createRoot(t);
  const body = "fixture";
  const removals = [];
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async () => response(200, body),
    readSignature: async () => ({ status: "Valid", signerOrganization }),
    removeImpl: async (directory, options) => {
      removals.push({ directory, options });
      await fs.rm(directory, options);
    },
  });
  const artifact = await manager.download(policyFor(body));

  await manager.cleanup(artifact.directory);
  await assert.rejects(fs.stat(artifact.directory), { code: "ENOENT" });
  await manager.cleanup(artifact.directory);
  assert.deepEqual(removals, [{ directory: artifact.directory, options: { recursive: true, force: true } }]);

  await assert.rejects(
    manager.cleanup(`${artifact.directory}-attacker-controlled`),
    { code: "INSTALLER_CLEANUP_NOT_ALLOWED" },
  );
  await assert.rejects(manager.cleanup(root), { code: "INSTALLER_CLEANUP_NOT_ALLOWED" });
});

test("preserves the primary failure and attaches sanitized cleanup diagnostics", async (t) => {
  const root = await createRoot(t);
  const body = "fixture";
  const primary = new WechatControlError("INSTALLER_SIGNATURE_INVALID", "primary failure", { stage: "signature" });
  const cleanupFailure = Object.assign(new Error("secret cleanup path must not leak"), { code: "EPERM" });
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async () => response(200, body),
    readSignature: async () => { throw primary; },
    removeImpl: async () => { throw cleanupFailure; },
  });

  await assert.rejects(manager.download(policyFor(body)), (error) => {
    assert.equal(error, primary);
    assert.deepEqual(error.details, { stage: "signature", cleanup: { code: "EPERM" } });
    assert.equal(JSON.stringify(error.details).includes("secret"), false);
    assert.equal(JSON.stringify(error.details).includes(root), false);
    return true;
  });
});

test("rejects malformed, multiple, unsafe, and mismatched Content-Length before writing", async (t) => {
  const cases = [
    ["combined", "7, 7", "INSTALLER_DOWNLOAD_FAILED"],
    ["negative", "-1", "INSTALLER_DOWNLOAD_FAILED"],
    ["leading zero", "07", "INSTALLER_DOWNLOAD_FAILED"],
    ["signed", "+7", "INSTALLER_DOWNLOAD_FAILED"],
    ["fractional", "7.0", "INSTALLER_DOWNLOAD_FAILED"],
    ["unsafe", "9007199254740992", "INSTALLER_DOWNLOAD_FAILED"],
    ["mismatch", "8", "INSTALLER_SIZE_MISMATCH"],
  ];
  for (const [label, contentLength, code] of cases) {
    await t.test(label, async (subtest) => {
      const root = await createRoot(subtest);
      let progressCalls = 0;
      const body = "fixture";
      const manager = createArtifactManager({
        tempRoot: root,
        fetchImpl: async () => ({
          ...response(200, body),
          headers: { get: (name) => name.toLowerCase() === "content-length" ? contentLength : null },
        }),
        readSignature: async () => assert.fail("signature must not be read"),
      });

      await assert.rejects(manager.download(policyFor(body), () => { progressCalls += 1; }), { code });
      assert.equal(progressCalls, 0);
      assert.deepEqual(await directoryEntries(root), []);
    });
  }
});

test("accepts an exact strict Content-Length", async (t) => {
  const root = await createRoot(t);
  const body = "fixture";
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async () => response(200, body, { "content-length": String(Buffer.byteLength(body)) }),
    readSignature: async () => ({ status: "Valid", signerOrganization }),
  });
  const artifact = await manager.download(policyFor(body));
  assert.equal(await fs.readFile(artifact.file, "utf8"), body);
  await manager.cleanup(artifact.directory);
});

test("normalizes URL, fetch, response, redirect, and body failures", async (t) => {
  const body = "fixture";
  const brokenBody = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("fix"));
      controller.error(Object.assign(new Error("secret body failure"), { code: "EIO" }));
    },
  });
  const cases = [
    ["invalid URL", "not a URL", async () => assert.fail("fetch must not run")],
    ["fetch rejection", undefined, async () => { throw Object.assign(new Error("secret fetch failure"), { code: "ECONNRESET" }); }],
    ["non-2xx", undefined, async () => response(503, body)],
    ["missing body", undefined, async () => ({ ...response(200, body), body: null })],
    ["malformed Location", undefined, async () => response(302, "", { location: "https://[invalid" })],
    ["body failure", undefined, async () => response(200, brokenBody)],
  ];
  for (const [label, url, fetchImpl] of cases) {
    await t.test(label, async (subtest) => {
      const root = await createRoot(subtest);
      const manager = createArtifactManager({
        tempRoot: root,
        fetchImpl,
        readSignature: async () => assert.fail("signature must not be read"),
      });
      await assert.rejects(
        manager.download({ ...policyFor(body), ...(url ? { url } : {}) }),
        (error) => {
          assert.equal(error.code, "INSTALLER_DOWNLOAD_FAILED");
          assert.equal(JSON.stringify(error.details || {}).includes("secret"), false);
          return true;
        },
      );
      assert.deepEqual(await directoryEntries(root), []);
    });
  }
});

test("preserves explicit download policy and security errors", async (t) => {
  const root = await createRoot(t);
  const explicit = new WechatControlError("INSTALLER_SIGNATURE_INVALID", "signature rejected");
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async () => { throw explicit; },
  });
  await assert.rejects(manager.download(policyFor("fixture")), (error) => error === explicit);
});

test("enforces per-hop timeout even when fetch ignores AbortSignal", async (t) => {
  const root = await createRoot(t);
  let signal;
  const manager = createArtifactManager({
    tempRoot: root,
    perHopTimeoutMs: 20,
    overallTimeoutMs: 1_000,
    fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  await assert.rejects(manager.download(policyFor("fixture")), {
    code: "INSTALLER_DOWNLOAD_FAILED",
    details: { stage: "timeout", scope: "hop" },
  });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(await directoryEntries(root), []);
});

test("enforces overall timeout while a response body stalls and cancels the body", async (t) => {
  const root = await createRoot(t);
  let cancelled = 0;
  const stalledBody = new ReadableStream({
    pull(controller) {
      if (controller.desiredSize > 0) controller.enqueue(Buffer.from("fix"));
      return new Promise(() => {});
    },
    cancel() { cancelled += 1; },
  });
  const manager = createArtifactManager({
    tempRoot: root,
    perHopTimeoutMs: 1_000,
    overallTimeoutMs: 20,
    fetchImpl: async () => response(200, stalledBody),
  });
  await assert.rejects(manager.download(policyFor("fixture")), {
    code: "INSTALLER_DOWNLOAD_FAILED",
    details: { stage: "timeout", scope: "overall" },
  });
  assert.equal(cancelled, 1);
  assert.deepEqual(await directoryEntries(root), []);
});

test("cleans an untracked allocation that resolves after the overall timeout", async (t) => {
  const root = await createRoot(t);
  let allocatorUsed = false;
  let lateDirectory;
  let releaseAllocation;
  let resolveAllocationCreated;
  let resolveLateCleanup;
  const allocationGate = new Promise((resolve) => { releaseAllocation = resolve; });
  const allocationCreated = new Promise((resolve) => { resolveAllocationCreated = resolve; });
  const lateCleanup = new Promise((resolve) => { resolveLateCleanup = resolve; });
  const manager = createArtifactManager({
    tempRoot: root,
    overallTimeoutMs: 20,
    mkdtempImpl: async (prefix) => {
      allocatorUsed = true;
      await allocationGate;
      lateDirectory = await fs.mkdtemp(prefix);
      resolveAllocationCreated();
      return lateDirectory;
    },
    removeImpl: async (directory, options) => {
      await fs.rm(directory, options);
      if (directory === lateDirectory) resolveLateCleanup();
    },
    fetchImpl: async () => new Promise(() => {}),
  });

  await assert.rejects(manager.download(policyFor("fixture")), {
    code: "INSTALLER_DOWNLOAD_FAILED",
    details: { stage: "timeout", scope: "overall" },
  });
  releaseAllocation();
  assert.equal(allocatorUsed, true);
  await allocationCreated;
  await lateCleanup;

  assert.deepEqual(await directoryEntries(root), []);
  await assert.rejects(manager.cleanup(lateDirectory), { code: "INSTALLER_CLEANUP_NOT_ALLOWED" });
});

test("cancels redirect bodies and clears all deadline timers after success", async (t) => {
  const root = await createRoot(t);
  let redirectCancelled = 0;
  const redirectBody = new ReadableStream({ cancel() { redirectCancelled += 1; } });
  const timers = new Set();
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, delay };
    timers.add(timer);
    return timer;
  };
  const clearTimeoutFn = (timer) => timers.delete(timer);
  const body = "fixture";
  let requests = 0;
  const manager = createArtifactManager({
    tempRoot: root,
    perHopTimeoutMs: 100,
    overallTimeoutMs: 1_000,
    setTimeoutFn,
    clearTimeoutFn,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1
        ? response(302, redirectBody, { location: "https://objects.githubusercontent.com/file.exe" })
        : response(200, body);
    },
    readSignature: async () => ({ status: "Valid", signerOrganization }),
  });
  const artifact = await manager.download(policyFor(body));
  assert.equal(redirectCancelled, 1);
  assert.equal(timers.size, 0);
  await manager.cleanup(artifact.directory);
});

test("preserves a malformed redirect error when redirect body cancellation fails", async (t) => {
  const root = await createRoot(t);
  let cancelled = 0;
  const redirectBody = new ReadableStream({
    cancel() {
      cancelled += 1;
      throw Object.assign(new Error("secret cancellation failure"), { code: "EIO" });
    },
  });
  const manager = createArtifactManager({
    tempRoot: root,
    fetchImpl: async () => response(302, redirectBody, { location: "https://[invalid" }),
  });

  await assert.rejects(manager.download(policyFor("fixture")), (error) => {
    assert.equal(error.code, "INSTALLER_DOWNLOAD_FAILED");
    assert.equal(JSON.stringify(error.details || {}).includes("secret"), false);
    return true;
  });
  assert.equal(cancelled, 1);
  assert.deepEqual(await directoryEntries(root), []);
});

test("clears hop and overall deadline timers when fetch rejects", async (t) => {
  const root = await createRoot(t);
  const timers = new Set();
  let timerCount = 0;
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, delay };
    timerCount += 1;
    timers.add(timer);
    return timer;
  };
  const clearTimeoutFn = (timer) => timers.delete(timer);
  const manager = createArtifactManager({
    tempRoot: root,
    perHopTimeoutMs: 100,
    overallTimeoutMs: 1_000,
    setTimeoutFn,
    clearTimeoutFn,
    fetchImpl: async () => { throw Object.assign(new Error("secret fetch failure"), { code: "ECONNRESET" }); },
  });

  await assert.rejects(manager.download(policyFor("fixture")), { code: "INSTALLER_DOWNLOAD_FAILED" });
  assert.equal(timerCount, 2);
  assert.equal(timers.size, 0);
  assert.deepEqual(await directoryEntries(root), []);
});
