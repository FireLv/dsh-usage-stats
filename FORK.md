# Fork 说明

本仓库是 [`menghun3-cn/dsh-usage-stats`](https://github.com/menghun3-cn/dsh-usage-stats) 的个人 fork，
**基线为 upstream tag `v0.2.27`**（commit `f38f55c40166ad3a4019df77b9f8ca43fdb0a27a`）。

该 upstream 自身又是 [`Ychris12138/dsh-usage-stats`](https://github.com/Ychris12138/dsh-usage-stats) 的 fork。

| 项 | 值 |
|---|---|
| 本仓库 | `https://github.com/FireLv/dsh-usage-stats` |
| 基线仓库 | `menghun3-cn/dsh-usage-stats` |
| 基线版本 | `v0.2.27` |
| 本 fork 版本 | `0.2.27-dsh.1` |
| 许可证 | MIT（与上游一致） |

---

## 为什么做这个 fork

上游在 `lib/index.js` 的 `collectUsage()` 中，一旦某个会话不再被 `sessions` 或
`sessionPersistence` 枚举，就执行：

```js
if (!attached.has(id) && !persistedIds.has(id)) delete cache.sessions[id];
```

这意味着 **删除一个对话会重写历史**：该会话已折叠的 token 用量被直接丢弃，
今日 / 本月 / 累计的数字会随之缩水。

本 fork 的目标：删除对话不应改变历史用量统计。

---

## 修改内容

### 1. 新增 `lib/archive.js`（197 行）

一个与折叠缓存分离的「已脱离会话归档」：

- 持久化位置：`<DSH_HOME>/storages/usage-stats-archive.json`
- 内存结构：`Map<sessionId, { detachedAt, days: Map<date, entry> }>`
- 与 `usage-stats-cache.json` 分离存放，**缓存版本升级或缓存损坏重建都不会抹掉已删除会话的历史**
- 边界：每会话最多保留 400 天（与在线保留一致），最多 2000 个归档会话（最旧先淘汰）
- 导出：`loadArchive` / `saveArchive` / `mergeArchiveInto` / `putArchiveSession` /
  `hasArchiveSession` / `deleteArchiveSession` / `trimArchive`

### 2. 修改 `lib/index.js`（+45 行 / -1 行）

只改 `collectUsage()` 及其调用路径：

- 会话消失时，把它的折叠天数移入归档，而不是 `delete cache.sessions[id]`
- 每次用量响应都通过 `mergeArchiveInto(byDay, archiveStore)` 合并归档数据
- **恢复路径**：同一 session id 重新可枚举时，先折叠日志、成功后才删除归档条目
  —— 折叠失败不丢归档，恢复成功不重复计数
- 归档加载按进程惰性执行一次（`loadArchiveOnce()`），避免重复 IO

### 3. 更新 `README.md`

增加归档行为的说明段落。

### 4. 更新 `package.json`

- `version`: `0.2.28` → `0.2.27-dsh.1`
- `description`: 补充 "with a detached-session archive so deleting a conversation does not erase its history"
- `repository` / `homepage` / `bugs`: 指向本 fork

---

## 与基线 `v0.2.27` 的文件级差异

| 文件 | 状态 |
|---|---|
| `lib/archive.js` | **新增** |
| `lib/index.js` | **修改**（`collectUsage()` 归档集成 + `rejectForeignCaller` 地址校验放宽） |
| `README.md` | **修改**（补充归档说明） |
| `package.json` | **修改**（版本号与仓库元数据） |
| `FORK.md` | **新增**（本文件） |
| 其余全部文件 | **与 `v0.2.27` 完全一致** |

`lib/accounts.js`、`lib/balance.js`、`lib/client.js`、`lib/subscriptions.js`、`lib/usage.js`
以及 `scripts/`、`catalog/`、`.github/workflows/`、`package-lock.json` 均保持基线原样。

---

## 版本记录

### `0.2.27-dsh.2`

- **放宽用量接口的对端地址校验**（`lib/index.js` 的 `rejectForeignCaller`）。
  上游只接受回环地址，导致通过局域网 IP 或反向代理（例如
  `dsh-mobile.946620884.xyz:8888`）打开面板时，`/api/usage-stats/*`
  一律返回 `HTTP 403 {"ok":false,"error":"forbidden"}`。
  现在接受**回环 + RFC1918 私有 IPv4**（含 `::ffff:` 映射形式），公网地址仍拒绝。
- 新增环境变量 `DSH_USAGE_STATS_STRICT_LOOPBACK=1`，可恢复上游的严格回环模式。
- 取舍说明：放宽模式下 `Host` 头不再作为安全边界（对端已被限定在私有网段），
  这同时支持「局域网 IP 直连」与「反向代理域名」两种访问方式。

### `0.2.27-dsh.1`

- 首个 fork 版本：新增 `lib/archive.js`，实现**删除会话后仍保留历史用量**。

---

## 从 upstream 升级

```bash
git remote add upstream https://github.com/menghun3-cn/dsh-usage-stats.git
git fetch upstream --tags
git merge upstream/main        # 冲突点只在 lib/index.js 的 collectUsage()
```

合并原则：**只保留两处 diff** —— `collectUsage()` 的归档分支，以及 `lib/archive.js`。
其余文件跟随 upstream。

> 注意：`v0.2.28` 相对 `v0.2.27` 没有任何 `lib/*.js` 代码改动（仅版本号、CI workflow、
> catalog 元数据与 README），因此从 0.2.27 升到 0.2.28 对本 fork 无功能收益。

---

## 验证

```bash
node --check lib/*.js
```

两项行为验证（开发时使用）：

1. 折叠真实的 `usage-stats-cache.json`，从持久化列表中移除一个会话，运行 `collectUsage()`
   —— 总 token 数不得变化，归档文件应包含该 session id。
2. 用不同 revision 与空日志重新加入该会话 —— 归档条目应消失，总数应恰好减少该会话此前的贡献
   （不重复计数）。
