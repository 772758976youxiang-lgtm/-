const summarize = (value) => String(value || "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 300);

export function createWechatPythonRuntime({ pythonBin, requirementsFile, run }) {
  if (!pythonBin) throw new Error("pythonBin is required");
  if (!requirementsFile) throw new Error("requirementsFile is required");
  if (typeof run !== "function") throw new Error("run is required");

  const probe = () => run(pythonBin, ["-c", "import wechatauto"]);

  return {
    async ensure() {
      const before = await probe();
      if (before.code === 0) return { installed: false };

      const install = await run(pythonBin, [
        "-m", "pip", "install", "--user", "--disable-pip-version-check", "-r", requirementsFile,
      ]);
      if (install.code !== 0) {
        const detail = summarize(install.stderr || install.stdout);
        throw new Error(`微信通道 Python 依赖安装失败${detail ? `：${detail}` : ""}`);
      }

      const after = await probe();
      if (after.code !== 0) {
        const detail = summarize(after.stderr || after.stdout);
        throw new Error(`微信通道 Python 依赖校验失败${detail ? `：${detail}` : ""}`);
      }
      return { installed: true };
    },
  };
}
