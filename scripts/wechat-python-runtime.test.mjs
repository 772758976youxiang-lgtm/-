import assert from "node:assert/strict";
import test from "node:test";
import { createWechatPythonRuntime } from "../wechat-python-runtime.mjs";

test("does not install requirements when wechatauto is already importable", async () => {
  const calls = [];
  const guard = createWechatPythonRuntime({
    pythonBin: "python",
    requirementsFile: "C:/plugin/wechat_channel/requirements.txt",
    run: async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "" };
    },
  });

  await guard.ensure();

  assert.deepEqual(calls, [["python", ["-c", "import wechatauto"]]]);
});

test("installs pinned requirements when wechatauto is missing", async () => {
  const calls = [];
  const guard = createWechatPythonRuntime({
    pythonBin: "python",
    requirementsFile: "C:/plugin/wechat_channel/requirements.txt",
    run: async (...args) => {
      calls.push(args);
      return calls.length === 1
        ? { code: 1, stderr: "No module named 'wechatauto'" }
        : { code: 0, stdout: "" };
    },
  });

  await guard.ensure();

  assert.deepEqual(calls, [
    ["python", ["-c", "import wechatauto"]],
    ["python", ["-m", "pip", "install", "--user", "--disable-pip-version-check", "-r", "C:/plugin/wechat_channel/requirements.txt"]],
    ["python", ["-c", "import wechatauto"]],
  ]);
});

test("reports a stable error when requirements installation fails", async () => {
  const guard = createWechatPythonRuntime({
    pythonBin: "python",
    requirementsFile: "C:/plugin/wechat_channel/requirements.txt",
    run: async (_command, args) => args[1] === "pip"
      ? { code: 1, stderr: "network unavailable" }
      : { code: 1, stderr: "No module named 'wechatauto'" },
  });

  await assert.rejects(guard.ensure(), { message: /微信通道 Python 依赖安装失败/ });
});
