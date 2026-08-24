import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createArtifactManager,
  readAuthenticodeSignature,
} from "../wechat-installer-artifact.mjs";

const signerOrganization = "Tencent Technology (Shenzhen) Company Limited";

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-artifact-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function response(status, body = "", headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: Readable.toWeb(Readable.from([Buffer.from(body)])),
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
