# sologsb-1122 隧道掌子面地质编录台（gbtunnelface）

面向隧道施工地质人员的掌子面编录工作台：逐循环编录围岩级别、岩性、节理产状与涌水情况，绘制岩性素描并用数字表示结构面，实时按 BQ 指标判定围岩级别并给出支护建议。纯前端单页应用，数据全部保存在浏览器本地。

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
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge}.vue
        └── utils/{db,geoMath,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |
| `/merge` | 离线交接合并：导出/导入交接包，按掌子面稳定编号认领，新增保留来源与顺序，冲突选主版本，节理/涌水改动后重算围岩判定，失败回滚可重试 | 全部四张表 + archive |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

## 离线交接合并（多平板断网编录）

几台平板断网后分别编录同一掌子面的节理组、涌水记录、围岩判定与素描线段，回驻地用 `/merge` 导入交接包合并，不再整份覆盖：

- **稳定编号认领**：掌子面以 `faceNo`（如 ZK-102）跨设备认领；节理组以 `掌子面编号 + 组号` 认领；涌水/判定/素描线段以全局稳定 `uid` 认领。各设备内部 id 不同也能对应到同一对象。
- **新增保留来源与顺序**：每条记录带 `meta.source`（来源设备名）与 `meta.seq`（设备内录入顺序），合并后在「新增」页签与各清单中可见。
- **冲突选主，未选仍可查**：同一对象两边都改时列为冲突，字段级对比基准/本地/导入，由地质员选定主版本；未选版本进入 `archive` 表归档，随时查看或恢复为主版本。
- **围岩判定重算**：合并提交时，若某掌子面的节理组/涌水/掌子面信息较基准有变化，自动按最新数据重算 BQ、[BQ] 与级别并追加新结论（带「合并重算」标记），不沿用旧结论。
- **失败回滚可重试**：合并先在内存算好计划，确认后在一个 Dexie 事务内提交四张业务表 + 归档表；任一步抛错整体回滚，原记录保留，页面给出「恢复重试」。
- **三包合并**：以 `localStorage['gbtunnelface:merge-base']` 保存上次同步基准，按「基准 / 本地 / 导入」三包判定仅一边改（自动合并）或两边都改（冲突）。

交接包为 JSON，含设备信息、四张表（子记录已按 `faceNo`  denormalize）与按掌子面编号归并的素描线段。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 五张表：`faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）、`archive`（归档备选版本）。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- v2 → v3 迁移：新增 `archive` 表；为存量记录补 `meta`（`uid` 由表名+id 确定性生成，同源设备可互相认领）。
- 每条业务记录带 `meta: { uid, source, seq }`：`uid` 全局稳定，`source` 为来源设备（种子数据为 `seed`），`seq` 为设备内录入顺序。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，跨设备合并时按掌子面编号归并。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录。

## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。
- **离线交接合并**：`/merge` 导出/导入交接包，按掌子面稳定编号三包合并，新增保留来源与顺序，冲突字段级对比由地质员选主、未选版本归档可查，节理/涌水改动后重算围岩判定，失败事务回滚可重试。
