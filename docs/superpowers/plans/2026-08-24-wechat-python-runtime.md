# WeChat Python Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the WeChat channel from starting until `wechatauto-replica==1.1.7` is available to the selected Python interpreter.

**Architecture:** A focused Node module owns Python import probing and the pinned requirements installation. `server.mjs` calls it before spawning `python -m wechat_channel`; failures stay in the existing channel state and do not start a child process.

**Tech Stack:** Node.js ESM, `node:test`, Python pip.

---

### Task 1: Python runtime guard

**Files:**
- Create: `wechat-python-runtime.mjs`
- Create: `scripts/wechat-python-runtime.test.mjs`
- Modify: `server.mjs:24-27,373-410`
- Modify: `package.json:25`

- [ ] **Step 1: Write the failing test**

```js
test("installs the pinned requirements when wechatauto cannot be imported", async () => {
  const calls = [];
  const guard = createWechatPythonRuntime({
    pythonBin: "python",
    requirementsFile: "C:/plugin/wechat_channel/requirements.txt",
    run: async (...args) => { calls.push(args); return calls.length === 1 ? { code: 1, stderr: "No module named wechatauto" } : { code: 0 }; },
  });
  await guard.ensure();
  assert.deepEqual(calls[1], ["python", ["-m", "pip", "install", "--user", "--disable-pip-version-check", "-r", "C:/plugin/wechat_channel/requirements.txt"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/wechat-python-runtime.test.mjs`

Expected: FAIL because `wechat-python-runtime.mjs` does not exist.

- [ ] **Step 3: Implement the guard and call it before Python spawn**

```js
await wechatPythonRuntime.ensure();
const child = spawn(PYTHON_BIN, ["-m", "wechat_channel", "run"], options);
```

The guard probes with `python -c "import wechatauto"`, performs the fixed requirements install only if absent, and probes once more. It throws a concise error when pip or the final probe fails.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test scripts/wechat-python-runtime.test.mjs && npm test`

Expected: focused guard tests and the full existing suite pass.

- [ ] **Step 5: Commit**

```bash
git add wechat-python-runtime.mjs scripts/wechat-python-runtime.test.mjs server.mjs package.json docs/superpowers
git commit -m "fix: install WeChat Python runtime dependency"
```
