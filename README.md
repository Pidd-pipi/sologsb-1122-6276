# sologsb-1122 隧道掌子面地质编录台（gbtunnelface）

面向隧道施工地质人员的掌子面编录工作台：逐循环编录围岩级别、岩性、节理产状与涌水情况，绘制岩性素描并用数字表示结构面，实时按 BQ 指标判定围岩级别并给出支护建议。纯前端单页应用，数据全部保存在浏览器本地。**支持多台平板断网分别编录、回驻地离线交接合并：按掌子面稳定编号认领，新增保留来源与顺序，双方改动列冲突由地质员选主版本，节理/涌水并入后自动重算围岩判定，失败整体回滚可重试。**

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21822**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（素描线段），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
npm run test:merge  # 离线合并引擎端到端测试（fake-indexeddb，无需浏览器）
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1122/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{face,joint,grade,water}.ts
        ├── stores/{face,joint,grade}Store.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard}.vue
        ├── hooks/{useFaceFilter,useGradeCalc}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge,Handover}.vue
        └── utils/{db,geoMath,id,device,sketchStore,handover,demoPeer}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |
| `/handover` | 离线交接：设备身份、导出/导入交接包、冲突选择、失败重试、落选与旧判定归档 | 全部表 + MergeBase/MergeSession/Archive |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 业务表：`faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）。
- 交接表（v3 新增）：`mergeBases`（按「掌子面编号 × 对端设备」存上次合并快照，支撑三方比对）、`mergeSessions`（成功/失败会话，失败会话保留原交接包与地质员已做选择）、`archives`（冲突落选版本、落选素描、重算前旧判定）。
- 每条业务记录带 `provenance`（首录设备 id/名称、设备内自增 `seq`、`updatedAt`），新增内容合并后保留来源并按现场顺序排列。
- v2 → v3 迁移：仅新增三张交接表与字段索引，历史数据不改动。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，刷新后仍在；合并前先备份，失败随之一并回滚。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录。

## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。

## 离线交接合并（断网多平板 → 回驻地合并）

现场几台平板断网后分别编录同一掌子面，传统「整份导入」会覆盖先录入的记录。本系统改为**三方合并**：

1. **设备身份与导包**：在「离线交接」页设置本机名称与地质员（首条记录起即盖 `provenance` 来源戳与顺序号），现场结束后「导出交接包」得到一个 JSON（四类记录 + 素描线段 + 来源与顺序）。驻地机可依次导入多台平板的包。
2. **按稳定编号认领**：掌子面以业务编号 `faceNo` 对齐（随机主键跨设备不可靠）；子记录按 `id` 对齐；素描线段按 `id` 对齐。本机不存在的编号整份新认领，子记录 `faceId` 自动重映射，节理组号撞车顺延。
3. **三方判定**：以「上次成功合并的快照」为基线——只一边改的直接采用；**两边都改的列为冲突**，预检页逐字段对比，由地质员在「本机版本 / 对端版本」间选主版本；未选版本不删除，进入 `archives` 归档随时可查。无基线又对不上时一律保守列冲突，绝不静默覆盖。
4. **新增保留来源与顺序**：新增节理/涌水/判定带来源设备标记；涌水清单在同里程按设备内 `seq` 稳定排序；素描按「基线 → 本机新增 → 对端新增」保序并集（重复线段去重），一边清空/删线而另一边新增时列冲突。
5. **关联围岩判定重算**：只要某掌子面的节理组或涌水有并入（新增/单边改/冲突落定），即按合并后数据重算 BQ、地下水修正 K1、Kv/Jv 与级别，生成 `recomputedAfterMerge` 新判定并记录 `supersedesGradeIds`；旧判定完整保留并归档，业务页只显示最新结论，**不沿用旧结论**。
6. **失败恢复**：合并在单个 Dexie 事务内执行，IndexedDB 失败自动回滚；localStorage 素描先备份再改，失败恢复原状；失败会话（含原包与已选项）落库，在「交接记录」点「恢复并重试」即可，重试前现场原记录不变。
7. **单机演练**：没有第二台平板时，导入区点「生成演练交接包」，会基于当前库模拟另一台平板的双方修改、股状涌水与新掌子面认领，直接进入预检流程。

> 合并完成后广播 `gbtunnelface:merged` 事件，Pinia store 与素描画布自动从本地库重载。
