# 非洲驻华记者台 — 驻外记者协作系统

面向非洲记者驻华多城市移动采访的独立运行协作服务。编辑部可掌握选题、行程与安全确认，同时对消息来源与记者实时位置分层保护。

## 能力一览

| 需求 | 实现 |
| --- | --- |
| 公开行程 / 受限采访计划 / 加密来源分层保存 | 三级分层记录（tier 1 明文、tier 2/3 AES-256-GCM 密封），授权按层级 + 范围（主题/具体来源）判定 |
| 临时变更通过有确认期限的事件传播 | 变更事件含 `deadline` 确认期限、指定受众（按人或角色）、逐人确认；逾期自动标记 overdue 并审计；非受众看不到内容 |
| 失联时按风险等级升级，不向无关人员暴露定位 | 标准风险逾期一级（仅安全岗）、宽限后二级（+管理员）；高风险逾期直接二级。位置密文存储，仅安全岗/管理员可解密；升级载荷**不含任何定位**；记者互不可见 |
| 费用预支与票据核销防重复 | 预支余额扣减；票据按 vendor+发票号+日期+金额+币种指纹去重；超额、跨币种、代人核销均被拒 |
| 采访授权到期自动收紧访问 | 授权含 `expiresAt`，每个检查点按服务器时间判定；到期后密文仍在但无法读取 |
| 弱网离线记录回传时检测冲突 | `/sync` 批量回传，`opId` 幂等；记录编辑以 `baseVersion` 乐观并发，冲突逐条报告（409），双方修改互不覆盖 |
| 系统恢复后继续安全计时 | 持久化单调时钟（只增不减），进程重启 / 系统时间回拨都不会重开已逾期状态或缩短期限 |
| 编辑可验证报道链路但看不到未授权来源 | `GET /records/:id/verify` 只返回内容哈希、密文完整性、账本锚点与链校验结果，全程不解密明文；并告知 `viewerMayReadPlaintext` |

另：所有写操作进入**追加式哈希链审计账本**（不可覆盖、断链/改条可被 `verifyChain` 发现），事件时间与服务器接收时间分别记录。

## 运行

```bash
npm start                      # 默认数据目录 ./data，监听 127.0.0.1:8000
PORT=8000 npm start
DESK_DATA_FILE=/srv/desk.json  # 自定义数据快照
DESK_DATA_KEY=base64(32字节)   # 注入主密钥；未提供时在 data/master.key 生成(0600)
DESK_BOOTSTRAP_ADMIN=admin     # 冷启动首个管理员标识（仅身份表为空时生效一次）
```

生产部署应置于完成 mTLS / 网关鉴权的环境内，由网关注入 `x-actor-id`，服务本身不直接面对公网。

## HTTP 接口

调用方身份通过 `x-actor-id` 请求头提供（稳定标识，约定见 `docs/domain.md`）。

**人员与授权（admin）**
- `POST /admin/actors` — 注册人员（journalist / editor / security / admin）
- `POST /admin/grants` — 签发授权 `{actorId, tier:1|2|3, scope:{kind:"all"|"subject"|"source",value}, expiresAt}`

**分层记录**
- `POST /records` — 创建 `{tier, subject, sourceId?, title, body?}`
- `PATCH /records/:id` — 更新（需 `baseVersion`，离线冲突时返回 409）
- `GET /records?tier=` — 列出当前身份可见的记录（不含无权层的明文）
- `GET /records/:id` — 读取（到期/越权返回 403）
- `GET /records/:id/verify` — 验证报道链路（不返回明文）

**临时变更事件**
- `POST /events` — 发布 `{title, severity, audience:{actorIds|roles}, deadline, summary?}`
- `POST /events/:id/ack` — 受众确认
- `GET /events` — 可见事件与确认进度

**安全报平安**
- `POST /safety/plans` — 设置行程安全计划 `{journalistId, riskLevel:"low"|"standard"|"high", intervalMs, graceMs}`
- `POST /safety/checkins` — 报平安 `{location?}`；离线可经 `/sync` 携带 `eventTime`
- `GET /safety/status` — 状态与升级级别（定位仅 security/admin 可见）

**费用**
- `POST /finance/advances` — 开立预支 `{journalistId, amount, currency?}`
- `POST /finance/receipts` — 提交票据核销（重复票据 409）
- `GET /finance/advances/:id` — 预支与已核销票据明细

**离线同步**
- `POST /sync` — `{ops:[{opId, type, entityId?, eventTime?, payload}]}`，支持 `record.create/update`、`event.ack`、`safety.checkin`、`finance.receipt`

**审计**
- `GET /audit?subject=` — 哈希链账本（仅 admin/security）

## 测试

```bash
npm test   # 33 个测试：分层授权、到期收紧、事件确认期限、风险升级、
           # 费用防重、离线冲突、持久化恢复、时钟单调、链路验证、HTTP 端到端
```

## 安全设计要点

- **密钥**：AES-256-GCM，AAD 绑定资源标识（`record:<id>` / `checkin:<id>`），密文不能被搬运到其他记录；主密钥经环境变量或 0600 文件注入，不入库。
- **时间信任**：当前时间只来自可信服务器时钟且单调持久化；客户端只能上报过去的事件时间，无法用改本机时钟缩短确认期限/授权期或提前关闭失联窗口。
- **最小暴露**：升级事件只含记者标识与级别；位置密文仅安全岗可解；同步幂等回执不落受限明文；记者默认只能看到自己的安全状态。
- **不可篡改**：账本哈希链启动时重放校验，任何改条、删条、断链都会导致拒绝启动或验证失败。
