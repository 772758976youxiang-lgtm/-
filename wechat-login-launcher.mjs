import path from "node:path";

export function createWechatLoginLauncher({ platform = process.platform, spawnProcess } = {}) {
  if (typeof spawnProcess !== "function") throw new Error("spawnProcess is required");

  return {
    launch(executable) {
      if (platform !== "win32") throw new Error("微信个人号通道仅支持 Windows");
      if (!executable || path.win32.basename(executable).toLowerCase() !== "weixin.exe") {
        throw new Error("未找到已校验的微信 4.x 客户端");
      }
      const child = spawnProcess(executable, [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
      child.unref?.();
      return executable;
    },
  };
}
