# Danbooru 结果中文化、链接附带与搜索提示优化设计

## 背景与意图 (Intent & Why)

Danbooru 图片检索（`/dbr`）与 Danbooru 网页链接预览目前均输出英文标签拼接的原版标题（如 `reisen udongein inaba (touhou) drawn by nacht musik`）。
同时 `/dbr` 的搜索纠错提示此前仅比对英文，且输出缺少帖子网页直链，不利于群友了解作品详情、对应中文角色译名及访问原帖。

本次改动旨在提升 Danbooru 相关功能在中文会话场景下的可读性与易用性：
1. 在 `/dbr` 图文结果中附带原帖直链；
2. 将 `/dbr` 及 Danbooru 链接预览返回的标签信息翻译为中文，并采用自然的中文句式；
3. 将 `/dbr` 纠错回显条件更新为“用户输入是否与实际搜索标签对应的中文一致”。

## 目标与非目标 (Goals & Non-Goals)

### 目标 (Goals)
1. **`/dbr` 附带链接**：在 `/dbr` 标题行后紧跟 Danbooru 帖子直链 `https://danbooru.donmai.us/posts/:id`。
2. **搜索提示词中文化**：当“用户原始输入”与“实际搜索词对应的中文（空格分隔）”不一致时，输出 `🔍 [中文标签]`；完全一致时不提示。
3. **返回数据标签中文化**：
   - 角色、作品（版权）、画师等标签通过本地 `assets/danbooru-tags.sqlite` 翻译为中文；
   - 标题连接词与数量省略均调整为中文（`画师`、顿号 `、`、`等 N 位/部`）；
   - 去重规则：若为单角色或所有角色属于同系列作品，去除角色名中自带的作品后缀 `（...）`，并在作品栏统一展示；若为跨系列多角色，保留角色名自带作品后缀以明确对应关系。
4. **链接预览同步中文化**：Danbooru 帖子链接（`/posts/:id`）预览复用相同的中文格式化逻辑，并去除 ` | Danbooru` 后缀。

### 非目标 (Non-Goals)
- 不改变 Danbooru 非 post 页面（如 `/artists`、`/wiki_pages` 等）的默认预览行为；
- 不在链接预览中额外增加网络请求。

## 约束 (Constraints)
- 遵循 Effect 4 与项目代码规范（无 `any`，严格 TypeScript 模式）；
- 本地缺少 `assets/danbooru-tags.sqlite` 数据库时需优雅降级（使用原英文标签回退）；
- 兼容 Metascraper 同步插件执行模型，不阻塞链接抓取链路。

## 技术方案对比与选型 (Approaches)

### 方案 A：复用 DOM 标签解析 + 统一标签翻译器（已采纳）
- **做法**：`/dbr` 与 Danbooru 链接预览共享同一套标签翻译与中文格式化器。链接预览在 `danbooruCustomizer.metascraperRules.title` 中从 HTML DOM 的侧边栏列表（`ul.character-tag-list li[data-tag-name]` 等）提取标签，本地 SQLite 查询 `cn_name` 进行翻译，输出无 ` | Danbooru` 后缀的中文标题。
- **权衡**：无额外网络开销，延迟极低，不触发 Danbooru API 频控。

### 方案 B：链接预览异步请求 Danbooru JSON API
- **做法**：在链接预览拦截到 `/posts/:id` 时请求 `posts/:id.json` 接口。
- **权衡**：打破 Metascraper 同步管线，增加网络往返和 429 风险。

## 详细设计 (Decisions & Details)

### 1. `/dbr` 回复消息结构
```text
🔍 [中文标签1] [中文标签2]   <-- 仅在“用户输入 != 实际搜索词对应的中文”时展示
[中文标题]
https://danbooru.donmai.us/posts/:id
[图片]
```

### 2. 搜索词提示逻辑
- 输入示例：“白发 猫耳” -> 检索标签 `white_hair cat_ears` -> 对应中文 `白发 猫耳`。用户输入与中文一致，不提示。
- 输入示例：“white_hair cat_ears” -> 对应中文 `白发 猫耳`。输入为英文，与中文不一致，提示 `🔍 白发 猫耳`。
- 输入示例：“初音” -> 纠错为 `hatsune_miku` -> 对应中文 `初音未来（VOCALOID）`。提示 `🔍 初音未来（VOCALOID）`。
- 若标签在数据库中无 `cn_name`，回退为英文标签原名。

### 3. 中文标题格式化 (`formatDanbooruTitleCn`)
- **角色提取与去重**：
  - 提取角色 `cn_name`（或英文名）；
  - 检测 `cn_name` 末尾的作品括号（如 `（东方Project）` 或 `(东方Project)`）；
  - 若仅 1 个角色，或所有角色的作品后缀完全相同，剥离角色中的作品后缀，由版权字段展示 `(作品名)`；
  - 若多个角色的作品后缀不相同（跨作品联动），保留角色中的作品后缀；
  - 最多展示 5 个角色，顿号 `、` 连接；超出 5 个追加 `等 N 位`。
- **版权/作品**：
  - 提取最多 1 个作品名；若多于 1 个追加 `等 N 部`；用半角括号包裹 `(作品名)`。
- **画师**：
  - 前缀为 `画师 `，多画师用顿号 `、` 连接。
- **组合形式**：
  - `角色列表 (作品) 画师 画师名`（各部分若为空则忽略）。
  - 若无角色且无作品，回退展示作品名或 `#ID`。

### 4. Danbooru 链接预览
- `danbooruCustomizer` 在 `LinkPreviewSites.ts` 中扩展 `metascraperRules.title`：
  - 针对 `/posts/:id` URL，从 `htmlDom` 中解析角色、版权、画师标签；
  - 调用相同的翻译格式化函数生成标题；
  - 去除原页面的 ` | Danbooru`。

## 实现细节留由构建者处理 (Left to Builder)
- SQLite 批量标签查询的辅助函数封装；
- 括号提取的正则健壮性（处理全角 `（` `）` 与半角 `(` `)`）；
- 降级模式（无 sqlite 数据库文件）下的优雅 fallback；
- 完善的单元测试覆盖。
