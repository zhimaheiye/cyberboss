# Grok Bot / 小宝云端二改日志（branch `grokbot`）

本分支是芝麻在云电脑上对 CyberBoss 的个人二改，配合 `/home/box/companion` 使用。  
格式：日期（Asia/Shanghai）→ 现象 → 原因 → 怎么修。

---

## 2026-09-28 查岗整天几乎不主动发微信

- **现象**：除日间轻触外，check-in 几乎全 `silent`；B 站 / MuMu 活跃也不催。
- **原因**：过夜催学修复后 default silent 过重；`send_message` JSON 脏尾巴被丢弃；tracker 过宽套用挂机豁免。
- **修复**：
  - `stream-delivery.js`：salvage 尾部脏 JSON；`scripts/check-system-reply-json-salvage.js` 自测。
  - `veglia-context.js` + checkin poller / dispatcher：交互式娱乐 prefer 短中文催一句；挂机高 idle 不算交互娱乐。
  - 收窄 happyfish 挂机豁免；companion tracker 清空过宽 `legitimate_play`（companion 侧，不在本仓）。

## 2026-09-28 API 429 泄漏到微信 / 切 242243 grok-4.6

- **现象**：微信出现 `API Error … 429`。
- **修复**：`sanitizeReplyText` 拦截 provider/quota 错误；运行时改走 242243 + `[Grok] grok-4.6`（env 不入库）。

## 2026-09-27 过夜催学轰炸与 Veglia 前置

- **修复**：03:00–09:00 静默；Veglia away/asleep/挂了则不唤醒；注入 LIVE snapshot；系统触发默认 silent。

## 说明

- 上游：`WenXiaoWendy/cyberboss`；本 fork：`zhimaheiye/cyberboss`。
- 陪伴工作区规则与时间轴仍在云电脑 `/home/box/companion`（不进本仓库，避免日记/状态噪音）。
- 不含 `.env` / API Key。

## 2026-10-13 查岗并入睡前/轻触提醒；触屏本 B 站先截图

- 问题：01:00 睡前提醒和白天轻触原由 Grok 定时任务负责，已暂停；触屏本开 B 站常是白噪音，只看窗口标题会误催。
- 修复：`system-checkin-poller.js` 查岗提示加入 01:00 睡前一句提醒（不列清单）和白天 11:20/14:20/16:20/19:20/21:20 轻触；`veglia-context.js` 对 lenovo-touch 上的 B 站标记 screenshot_first，先截图判断是白噪音还是在看视频再决定是否提醒。
