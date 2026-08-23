// 真人账号扫码登录助手（dws auth login --device 设备流）
// 用法：
//   node auth.mjs login     -> 打印授权 URL+user_code（转发给用户扫码），并轮询 profile.list 直到登录成功
//   node auth.mjs status    -> 打印当前已登录账号（profile）列表
//   node auth.mjs --profile <corp:user>   （可选，配合 login 指定授权目标组织）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DWS_BIN = process.env.DWS_BIN || [
  path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "dws.exe" : "dws"),
  process.platform === "win32" ? "dws.exe" : "dws",
].find((candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate));
const NOW = () => new Date().toISOString().slice(11, 19);

function run(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(DWS_BIN, args, { shell: false }); } catch (e) { resolve({ code: -1, stdout: "", stderr: String(e) }); return; }
    let out = "", err = "";
    const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => err += d);
    child.on("close", (code) => { clearTimeout(to); resolve({ code, stdout: out, stderr: err }); });
  });
}

async function profiles() {
  const r = await run(["profile", "list", "-f", "json"], 15000);
  try {
    const j = JSON.parse(r.stdout || "{}");
    const arr = Array.isArray(j) ? j : (j.profiles || j.items || []);
    return arr.map((p) => ({
      profile: p.profile ?? `${p.corpId ?? p.corp_id}:${p.userId ?? p.user_id}`,
      corp: p.corpId ?? p.corp_id, user: p.userId ?? p.user_id,
      corpName: p.corpName ?? p.corp_name ?? "", userName: p.userName ?? p.user_name ?? "",
    }));
  } catch { return []; }
}

async function login() {
  const target = (() => {
    const eq = process.argv.find((a) => a.startsWith("--profile="));
    if (eq) return eq.split("=")[1];
    const idx = process.argv.indexOf("--profile");
    return idx >= 0 ? process.argv[idx + 1] : null;
  })();
  console.log(`[${NOW()}] 启动扫码登录（dws auth login --device${target ? " --profile " + target : ""}）…`);
  const args = ["auth", "login", "--device"];
  if (target) args.push("--profile", target);
  const child = spawn(DWS_BIN, args, { shell: false });
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));

  const before = new Set((await profiles()).map((p) => p.profile));
  const deadline = Date.now() + 120000; // 最多等 2 分钟（超时即退出）
  while (Date.now() < deadline) {
    const ps = await profiles();
    const found = ps.find((p) => !before.has(p.profile));
    if (found) {
      console.log(`\n[${NOW()}] ✅ 扫码登录成功：${found.corpName || found.corp} ${found.userName || found.user} (${found.profile})`);
      try { child.kill("SIGTERM"); } catch {}
      // 扫码成功即自动注册真人通道（无需再问）
      try {
        const acctId = (found.user || "u").replace(/[^A-Za-z0-9_-]/g, "").slice(-10) || "u";
        const regBody = { id: `dingtalk-person-${acctId}`, platform: "dingtalk", name: `钉钉-${found.userName || found.user}-数字人`, mode: "dws", profile: found.profile, ignoreSenders: ["harness"], enabled: true };
        const rr = await fetch("http://127.0.0.1:5175/api/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(regBody) });
        const rj = await rr.json().catch(() => ({}));
        console.log(`[自动注册] ${rj.ok ? "OK " + rj.id : "FAIL " + (rj.error || JSON.stringify(rj))}`);
      } catch (e) { console.log("[自动注册失败]", e?.message ?? e); }
      return { ok: true, profile: found.profile, name: found.userName || found.user, corp: found.corp, user: found.user };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`\n[${NOW()}] ⏱ 超时未检测到登录完成——请确认用户在浏览器里完成了扫码授权`);
  try { child.kill("SIGTERM"); } catch {}
  return { ok: false };
}

const cmd = process.argv[2] || "status";
if (cmd === "login") {
  login().then((r) => { console.log("RESULT:" + JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
} else {
  profiles().then((ps) => { console.log(JSON.stringify(ps, null, 2)); });
}
