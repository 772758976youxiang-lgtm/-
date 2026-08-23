# Windows 网关（WeChat-Hook 4.1.10.27）使用说明

## 环境（Windows）
1. 微信 PC **4.1.10.27**（小号登录）；关闭自动升级
2. 下载 aixed/WeChat-Hook Release 的 `version.dll` → 放入微信安装目录
   `C:\Program Files\Tencent\Weixin`
3. 杀毒/Defender 白名单：微信目录 + version.dll（hook 常被误杀）
4. 启动微信 → 正常登录 → 校验：`curl http://127.0.0.1:30001/QueryDB/GetAllDBName`

## 网关
```
python gateway.py
```
- **首跑**（debug_discover=true）会打印全部库/表 → 把消息库与表填进 config.json `SCHEMA`、debug_discover 设 false；
- SCHEMA 字段名以实际表结构为准（联调时改成真实列名）；
- 把 `mac_url` 改成 Mac 的局域网 IP（Mac 上演示台正在运行 8789）。

## 工作流
微信新消息 → 网关轮询到 → POST Mac `/api/incoming` →（Mac agent 生成回复）→ 网关 `/SendTextMsg` 发回。
