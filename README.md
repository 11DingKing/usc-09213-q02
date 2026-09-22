# 非洲驻华记者台

面向多机构协作场景的驻外记者协作服务：编辑部掌握选题、行程与安全确认，同时保护消息来源与记者实时位置。

## 运行

```bash
npm start                 # 启动服务（默认 127.0.0.1:8000，数据目录 ./data）
DESK_DATA_DIR=/path PORT=8000 node src/server.mjs
npm test                  # 运行全部行为测试
```

所有 `/v1/*` 接口需要 `Authorization: Bearer <token>`。开发环境内置成员见 `src/app.mjs` 的 `defaultConfig`（记者 tok-jour-1、编辑 tok-ed-1、安全 tok-sec-1、财务 tok-fin-1、管理员 tok-admin 等），生产部署应替换为受控配置。

## 能力概览

- **分层数据**：公开行程 / 受限采访计划 / 加密来源三层，访问策略逐层收紧（见 `docs/domain.md`）。
- **变更事件**：临时变更携带确认期限传播，全员确认生效，逾期自动失效。
- **安全确认**：按风险等级的失联升级（L1 本人 / L2 编辑 / L3 安全官），定位仅对本人与安全角色开放。
- **费用**：预支幂等、票据号防重、核销一次性且不超额。
- **采访授权**：到期自动收紧访问，撤销立即生效。
- **离线回传**：弱网笔记按基线版本回传，冲突双方保留、人工解决。
- **恢复**：状态写穿落盘 + 追加式哈希链审计，重启后所有计时从持久化时间戳继续。
- **链路核验**：编辑可验证报道引用链完整性，但拿不到未授权的来源内容（来源端到端加密，密钥按人包裹）。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/journalists` | 注册记者档案（管理员） |
| POST/GET | `/v1/itineraries[/:id]` | 公开行程 |
| POST/GET | `/v1/plans[/:id]` | 受限采访计划 |
| POST | `/v1/sources` | 上传加密来源（密文 + 明文哈希 + 包裹密钥） |
| GET | `/v1/sources/:id[/meta|/key]` | 来源内容 / 元数据 / 我的包裹密钥 |
| POST/DELETE | `/v1/sources/:id/grants[/:pid]` | 来源授权与撤销 |
| POST | `/v1/changes`、`/v1/changes/:id/confirm` | 变更事件与确认 |
| POST | `/v1/safety/checkins` | 安全签到 |
| GET | `/v1/safety/:jid[/location]` | 失联状态 / 精确定位（本人与安全角色） |
| POST | `/v1/expenses/advances[/:id/approve|/disburse]` | 预支申请/审批/拨付 |
| POST | `/v1/expenses/advances/:id/receipts`、`/v1/expenses/receipts/:id/reconcile` | 票据提交与核销 |
| POST | `/v1/authorizations`、`/v1/authorizations/:id/revoke` | 采访授权与撤销 |
| POST | `/v1/notes`、`PATCH /v1/notes/:id` | 现场笔记（带 baseVersion） |
| POST | `/v1/offline/sync`、`/v1/offline/conflicts/:id/resolve` | 批量回传与冲突解决 |
| POST | `/v1/reports`、`GET /v1/reports/:id/verify` | 发布报道与链路核验 |
| GET | `/v1/notifications` | 我的通知 |
| GET | `/v1/audit`、`/v1/audit/verify` | 审计查询与哈希链校验（管理员/安全） |

业务数据与敏感配置应放在受控运行环境中；`./data` 仅用于本地运行。
