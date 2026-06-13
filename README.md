# 冷链交接异常处理 API

本地冷链箱流转管理系统，用于门店与仓库之间的冷链箱交接、温度校验、封签核验、异常冻结与主管复核。

---

## 1. 快速启动

```bash
npm install
npm start
```

服务启动后监听 `http://localhost:3000`。

### 健康检查

```bash
curl http://localhost:3000/health
```

---

## 2. 全局约定

### 2.1 请求头（所有写操作必填）

| 名称         | 值                  | 说明                       |
| ------------ | ------------------- | -------------------------- |
| x-operator   | 任意字符串          | 操作人姓名                 |
| x-role       | `staff` / `supervisor` | 普通员工 / 主管            |

### 2.2 箱子状态（流转顺序）

| 状态码            | 中文     | 说明                         |
| ----------------- | -------- | ---------------------------- |
| PENDING_OUTBOUND  | 待出库   | 导入箱单后初始状态           |
| IN_TRANSIT        | 运输中   | —（简化模型中出库直接→待签收） |
| PENDING_SIGN      | 待签收   | 已出库，等待门店签收         |
| SIGNED            | 已签收   | 门店签收成功                 |
| FROZEN            | 异常冻结 | 任意环节发现异常，员工冻结   |
| REVIEWED_CLOSED   | 复核关闭 | 主管确认异常并关闭           |

### 2.3 状态流转图

```
导入 → 待出库 → (出库) → 待签收 → (签收) → 已签收
          ↓         ↓         ↓         ↓
          └───────(异常冻结)───────────→ 异常冻结 → (主管复核) → 复核关闭
```

---

## 3. 接口列表

### 3.1 配置管理

**GET /api/configs** — 查看当前配置
```bash
curl http://localhost:3000/api/configs
```

默认配置：
| 键名          | 默认值        | 说明                     |
| ------------- | ------------- | ------------------------ |
| temp_min      | `-25`         | 最低温度阈值（°C）       |
| temp_max      | `-10`         | 最高温度阈值（°C）       |
| timeout_hours | `24`          | 出库→签收超时时长（小时）|
| seal_pattern  | `^SEAL\d{6,12}$` | 封签号正则           |

**PUT /api/configs** — 修改配置（仅主管）
```bash
curl -X PUT http://localhost:3000/api/configs \
  -H "Content-Type: application/json" \
  -H "x-operator: 张主管" \
  -H "x-role: supervisor" \
  -d '{"key":"temp_max","value":"-8"}'
```

### 3.2 箱单导入 / 查询

**POST /api/batches/import** — 导入箱单（普通员工或主管）
```bash
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH20260613001",
    "source_type": "warehouse",
    "source_name": "中央冷链仓",
    "target_type": "store",
    "target_name": "朝阳门店",
    "boxes": [
      {"box_no": "BOX001", "temperature": -18, "seal_no": "SEAL000001", "product_name": "冻牛肉", "weight": 25.5},
      {"box_no": "BOX002", "temperature": -20, "seal_no": "SEAL000002", "product_name": "冻猪肉", "weight": 30.0},
      {"box_no": "BOX003", "temperature": -15, "seal_no": "SEAL000003", "product_name": "冰淇淋", "weight": 12.8}
    ]
  }'
```

**GET /api/batches** — 搜索批次
```bash
curl "http://localhost:3000/api/batches?keyword=朝阳"
curl "http://localhost:3000/api/batches?batch_no=BATCH20260613001"
curl "http://localhost:3000/api/batches?status=FROZEN"
```

**GET /api/batches/:batch_no** — 批次详情（含箱子明细）
```bash
curl http://localhost:3000/api/batches/BATCH20260613001
```

**GET /api/boxes/:box_no** — 按箱号查询（跨批次）
```bash
curl http://localhost:3000/api/boxes/BOX001
```

### 3.3 出库与签收

**POST /api/batches/:batch_no/outbound** — 执行出库
```bash
curl -X POST http://localhost:3000/api/batches/BATCH20260613001/outbound \
  -H "x-operator: 仓管员小李" \
  -H "x-role: staff"
```

**POST /api/batches/:batch_no/sign** — 签收（逐箱校验温度+封签）
```bash
curl -X POST http://localhost:3000/api/batches/BATCH20260613001/sign \
  -H "Content-Type: application/json" \
  -H "x-operator: 门店收货员小刘" \
  -H "x-role: staff" \
  -d '{
    "boxes_sign": [
      {"box_no": "BOX001", "sign_temperature": -17, "sign_seal_no": "SEAL000001"},
      {"box_no": "BOX002", "sign_temperature": -19, "sign_seal_no": "SEAL000002"},
      {"box_no": "BOX003", "sign_temperature": -16, "sign_seal_no": "SEAL000003"}
    ]
  }'
```

### 3.4 异常处理

**POST /api/batches/:batch_no/freeze** — 异常冻结（整批或单箱）
```bash
# 整批冻结
curl -X POST http://localhost:3000/api/batches/BATCH20260613002/freeze \
  -H "Content-Type: application/json" \
  -H "x-operator: 门店收货员小刘" \
  -H "x-role: staff" \
  -d '{
    "reason": "开箱发现部分箱温度偏高，疑似冷链断裂",
    "evidence": "照片链接：https://example.com/photo123.jpg"
  }'

# 单箱冻结
curl -X POST http://localhost:3000/api/batches/BATCH20260613002/freeze \
  -H "Content-Type: application/json" \
  -H "x-operator: 门店收货员小刘" \
  -H "x-role: staff" \
  -d '{
    "box_no": "BOX005",
    "reason": "BOX005 封签破损",
    "evidence": "封签照片 S3://bucket/seal.jpg"
  }'
```

**POST /api/batches/:batch_no/review-close** — 主管复核关闭（仅 supervisor）
```bash
# 整批关闭
curl -X POST http://localhost:3000/api/batches/BATCH20260613002/review-close \
  -H "Content-Type: application/json" \
  -H "x-operator: 张主管" \
  -H "x-role: supervisor" \
  -d '{
    "opinion": "确认冷链故障，已通知供应商理赔，该批次关闭"
  }'
```

### 3.5 审计日志

**GET /api/audit-logs** — 查询操作时间线
```bash
curl "http://localhost:3000/api/audit-logs?batch_no=BATCH20260613001"
curl "http://localhost:3000/api/audit-logs?box_no=BOX001"
```

---

## 4. 完整样例链路（按顺序执行）

### 4.1 正常流程：导入 → 出库 → 签收

```bash
# Step 1: 导入箱单
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH20260613001",
    "source_type": "warehouse",
    "source_name": "中央冷链仓",
    "target_type": "store",
    "target_name": "朝阳门店",
    "boxes": [
      {"box_no": "BOX001", "temperature": -18, "seal_no": "SEAL000001", "product_name": "冻牛肉", "weight": 25.5},
      {"box_no": "BOX002", "temperature": -20, "seal_no": "SEAL000002", "product_name": "冻猪肉", "weight": 30.0}
    ]
  }'

# Step 2: 查询详情（应为 待出库）
curl http://localhost:3000/api/batches/BATCH20260613001

# Step 3: 执行出库（状态 → 待签收）
curl -X POST http://localhost:3000/api/batches/BATCH20260613001/outbound \
  -H "x-operator: 仓管员小李" \
  -H "x-role: staff"

# Step 4: 门店签收（状态 → 已签收）
curl -X POST http://localhost:3000/api/batches/BATCH20260613001/sign \
  -H "Content-Type: application/json" \
  -H "x-operator: 门店收货员小刘" \
  -H "x-role: staff" \
  -d '{
    "boxes_sign": [
      {"box_no": "BOX001", "sign_temperature": -17, "sign_seal_no": "SEAL000001"},
      {"box_no": "BOX002", "sign_temperature": -19, "sign_seal_no": "SEAL000002"}
    ]
  }'

# Step 5: 查看审计时间线
curl "http://localhost:3000/api/audit-logs?batch_no=BATCH20260613001"
```

### 4.2 异常流程：导入 → 出库 → 异常冻结 → 主管复核关闭

```bash
# Step 1: 导入第二个批次
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH20260613002",
    "source_type": "warehouse",
    "source_name": "中央冷链仓",
    "target_type": "store",
    "target_name": "海淀门店",
    "boxes": [
      {"box_no": "BOX003", "temperature": -18, "seal_no": "SEAL000003", "product_name": "冰淇淋", "weight": 12.8},
      {"box_no": "BOX004", "temperature": -22, "seal_no": "SEAL000004", "product_name": "冻虾", "weight": 18.0}
    ]
  }'

# Step 2: 出库
curl -X POST http://localhost:3000/api/batches/BATCH20260613002/outbound \
  -H "x-operator: 仓管员小李" \
  -H "x-role: staff"

# Step 3: 门店收货时发现异常 → 整批冻结
curl -X POST http://localhost:3000/api/batches/BATCH20260613002/freeze \
  -H "Content-Type: application/json" \
  -H "x-operator: 门店收货员小赵" \
  -H "x-role: staff" \
  -d '{
    "reason": "运输车制冷设备故障，到达时箱体明显升温",
    "evidence": "测温照片显示 5°C，远超阈值；记录仪截图"
  }'

# Step 4: 查询（状态应为 异常冻结）
curl http://localhost:3000/api/batches/BATCH20260613002

# Step 5: 普通员工尝试关闭（应报错 400 PERMISSION_DENIED）
curl -X POST http://localhost:3000/api/batches/BATCH20260613002/review-close \
  -H "Content-Type: application/json" \
  -H "x-operator: 门店收货员小赵" \
  -H "x-role: staff" \
  -d '{"opinion":"试关闭"}'

# Step 6: 主管复核关闭（成功）
curl -X POST http://localhost:3000/api/batches/BATCH20260613002/review-close \
  -H "Content-Type: application/json" \
  -H "x-operator: 张主管" \
  -H "x-role: supervisor" \
  -d '{
    "opinion": "确认制冷故障属实，已协调供应商重新发货，本批次销毁处理并关闭"
  }'

# Step 7: 查看审计时间线
curl "http://localhost:3000/api/audit-logs?batch_no=BATCH20260613002"
```

---

## 5. 错误场景验证（应返回清晰错误且不修改状态）

### 5.1 重复箱号导入

```bash
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH_DUP_BOX",
    "source_type": "warehouse", "source_name": "中央冷链仓",
    "target_type": "store", "target_name": "西城门店",
    "boxes": [
      {"box_no": "BOX001", "temperature": -18, "seal_no": "SEAL000001"}
    ]
  }'
```

预期：`{"error":{"code":"DUPLICATE_BOX","message":"箱号 BOX001 已存在"}}`，批次 BATCH_DUP_BOX 不会被创建。

### 5.2 重复批次号

```bash
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH20260613001",
    "source_type": "warehouse", "source_name": "中央冷链仓",
    "target_type": "store", "target_name": "西城门店",
    "boxes": [
      {"box_no": "BOX_NEW", "temperature": -18, "seal_no": "SEAL999999"}
    ]
  }'
```

预期：`{"error":{"code":"DUPLICATE_BATCH","message":"批次号 BATCH20260613001 已存在"}}`。

### 5.3 重复签收

```bash
# 对已签收的 BATCH20260613001 再次发起签收
curl -X POST http://localhost:3000/api/batches/BATCH20260613001/sign \
  -H "Content-Type: application/json" \
  -H "x-operator: 门店收货员小刘" \
  -H "x-role: staff" \
  -d '{
    "boxes_sign": [
      {"box_no": "BOX001", "sign_temperature": -17, "sign_seal_no": "SEAL000001"}
    ]
  }'
```

预期：`INVALID_STATUS` 或 `DUPLICATE_SIGN` 错误，状态不变。

### 5.4 温度格式不合法

```bash
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH_BAD_TEMP",
    "source_type": "warehouse", "source_name": "中央冷链仓",
    "target_type": "store", "target_name": "东城门店",
    "boxes": [
      {"box_no": "BOX_BAD", "temperature": "零下十八度", "seal_no": "SEAL111111"}
    ]
  }'
```

预期：`{"error":{"code":"INVALID_TEMPERATURE","message":"箱号 BOX_BAD：温度值 \"零下十八度\" 格式不合法，必须是数字"}}`。

### 5.5 超出温度阈值

```bash
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH_OVER_TEMP",
    "source_type": "warehouse", "source_name": "中央冷链仓",
    "target_type": "store", "target_name": "东城门店",
    "boxes": [
      {"box_no": "BOX_OVER", "temperature": 5, "seal_no": "SEAL222222"}
    ]
  }'
```

预期：温度超出 `[-25, -10]` 范围报错。

### 5.6 封签格式错误

```bash
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "x-operator: 仓库员小王" \
  -H "x-role: staff" \
  -d '{
    "batch_no": "BATCH_BAD_SEAL",
    "source_type": "warehouse", "source_name": "中央冷链仓",
    "target_type": "store", "target_name": "东城门店",
    "boxes": [
      {"box_no": "BOX_SEAL", "temperature": -18, "seal_no": "ABC123"}
    ]
  }'
```

预期：封签号需匹配 `^SEAL\d{6,12}$` 报错。

### 5.7 普通员工关闭异常

见 4.2 节 Step 5，预期返回 `PERMISSION_DENIED`，异常状态不改变。

---

## 6. 数据持久化说明

- 数据库文件位于 `./src/data/cold_chain.db`（SQLite WAL 模式）
- 停止/重启服务后，以下数据**保留**：
  - 批次状态、箱子状态
  - 异常冻结原因、冻结证据、冻结操作人、冻结时间
  - 主管复核意见、复核人、复核时间
  - 完整审计时间线（操作人、动作、前后状态、证据、时间戳）
- 如需重置数据，删除 `./src/data/cold_chain.db` 及 `cold_chain.db-*` 文件后重启服务即可。

---

## 7. 项目结构

```
lfc-00004/
├── package.json
├── README.md
├── regression-test.js                 # 签收回归测试
├── regression-test-inventory-check.js # 盘点模块回归测试
└── src/
    ├── server.js                      # 服务入口
    ├── constants.js                   # 统一枚举、标签、审计动作、错误码→HTTP映射
    ├── data/                          # SQLite 数据目录（自动生成）
    ├── middleware/
    │   └── validator.js               # 权限 + 温度/封签/超时校验
    ├── models/
    │   ├── db.js                      # 建表 + 初始化
    │   ├── dataModel.js               # 箱子状态机 + 数据访问层
    │   └── inventoryCheckModel.js     # 盘点数据访问层（纯 SQL）
    ├── services/
    │   └── inventoryCheckService.js   # 盘点业务逻辑（校验、状态流转、差异计算）
    └── routes/
        ├── index.js                   # 批次/签收/冻结 API 路由
        └── inventoryCheck.js          # 盘点 API 路由
```

---

## 8. 错误码一览

| 错误码                  | 触发场景                               |
| ----------------------- | -------------------------------------- |
| `MISSING_OPERATOR`      | 缺少 x-operator 头                     |
| `INVALID_ROLE`          | x-role 无效                            |
| `PERMISSION_DENIED`     | 非主管执行复核关闭 / 修改配置          |
| `DUPLICATE_BATCH`       | 批次号重复                             |
| `DUPLICATE_BOX`         | 箱号重复                               |
| `DUPLICATE_SIGN`        | 重复签收                               |
| `INVALID_TEMPERATURE`   | 温度格式或范围不合法                   |
| `INVALID_SEAL`          | 封签格式不合法                         |
| `TIMEOUT`               | 签收超时                               |
| `BATCH_NOT_FOUND`       | 批次不存在                             |
| `BOX_NOT_FOUND`         | 箱子不存在                             |
| `INVALID_STATUS_TRANSITION` | 不符合状态流转规则                 |
| `ALREADY_FROZEN`        | 已冻结的批次/箱子再冻结                |
| `ALREADY_CLOSED`        | 已关闭的批次/箱子再冻结                |
| `NOT_FROZEN`            | 非冻结状态下尝试复核关闭               |
| `DUPLICATE_CHECK_NO`    | 盘点单号重复                           |
| `CHECK_NOT_FOUND`       | 盘点单不存在                           |
| `CHECK_NOT_DRAFT`       | 非草稿状态尝试修改盘点单               |
| `CHECK_ALREADY_SUBMITTED`| 盘点单已提交，不可重复提交            |
| `CHECK_ALREADY_CONFIRMED`| 盘点单已确认，不可再操作              |
| `CHECK_NOT_SUBMITTED`   | 盘点单未提交，无法确认                 |
| `DUPLICATE_BOX_IN_CHECK`| 同一盘点单中箱号重复                   |
| `DUPLICATE_BOX_IN_REQUEST`| 同一请求中箱号重复                   |
| `BOX_CLOSED`            | 箱号已关闭，不可盘点                   |
| `BOX_FROZEN`            | 箱号已冻结，不可盘点                   |
| `EMPTY_CHECK_ITEMS`     | 盘点单无扫描明细，无法提交             |
