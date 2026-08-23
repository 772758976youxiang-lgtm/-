import { spawnSync } from "node:child_process";

const configured = process.env.DSH_WECHAT_PYTHON;
const candidates = [
  ...(configured ? [{ command: configured, prefix: [] }] : []),
  { command: "python", prefix: [] },
  { command: "python3", prefix: [] },
  ...(process.platform === "win32" ? [{ command: "py", prefix: ["-3"] }] : []),
];

let selected;
for (const candidate of candidates) {
  const probe = spawnSync(candidate.command, [...candidate.prefix, "--version"], { encoding: "utf8" });
  if (probe.status !== 0) continue;
  const version = `${probe.stdout}${probe.stderr}`.match(/Python\s+(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 9)) continue;
  selected = candidate;
  break;
}

if (!selected) {
  console.error("微信通道测试需要 Python 3.9+；可通过 DSH_WECHAT_PYTHON 指定解释器路径。");
  process.exit(1);
}

const result = spawnSync(
  selected.command,
  [...selected.prefix, "-m", "unittest", "discover", "-s", "tests", "-p", "test_wechat_channel*.py"],
  { stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
);
process.exit(result.status ?? 1);
