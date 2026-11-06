# dshsess

DSH 会把自己的会话写成 `~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`。
那不是一个普通 gzip 文件：它是**多帧 zstd**，Node 自带的 `zstdDecompressSync` 只会解出第一帧（约 226 字节）就停下，还不报错。所以拿现成工具去读，看到的是「4 行、0.3 KB」——真实会话可能是 40 万行、587 MB。

这个 CLI 用 [zstdframes](https://www.npmjs.com/package/zstdframes) 按 magic 切帧，把整个会话读出来，做成几个能直接用的视图。

## 用法

```bash
dshsess list                          # 最近的会话：时间、体积、id、工作区
dshsess list --since 2026-10-01 --cwd my-dsh-plugins
dshsess stats                         # 按工作区汇总
dshsess show 8b1a3304                 # 会话头：事件数、工具调用/错误、turn 结局分布
dshsess show 8b1a3304 --turns         # 逐轮：步数、工具数、错误数、结束原因、耗时
dshsess show 8b1a3304 --types         # 事件类型直方图
dshsess failures 8b1a3304             # 工具错误按 name:code 聚合
dshsess grep 'FS_EDIT_NOT_FOUND' --session 8b1a3304
```

会话 id 打前缀就够（`8b1a3304` 或 `session-8b1a`）：

```console
$ dshsess show 8b1a3304 --turns
session   session-8b1a3304-326b-44bc-9440-b6600de0329c
cwd       D:\Code\DSH工作区\炎火云服务器8c8g
events    46685
tools     6709 calls, 60 errors
turns     {"completed":145,"error":75,"aborted":15,"max-tokens":3,"interrupted":3}

turn  steps  tools  errors  end        duration
   1    103    125       0  completed  3499s
   2     97    103       0  completed  3653s
  12     18     28       0  error      187s
```

## 失败是怎么判定的

不看正文。`tool/result` 上有两个字段是真信号：

| 字段 | 含义 |
| --- | --- |
| `data.error` | 工具失败，形如 `{name:'FsError', code:'FS_EDIT_NOT_FOUND'}` |
| `data.meta.opsShell.exitCode` | bash 命令的真实退出码 |
| `turn/end.data.reason.kind` | `completed` / `error` / `aborted` / `max-tokens` / `interrupted` |

用正则去匹配正文里的 `"ok":false` 是错的——`tool/result` 根本没有 `ok` 字段，正文里的 `[exit code:` 之类会把正常输出也算成失败。

## 库用法

```js
import { listSessions, summarize, turns, readFirstEvent } from 'dshsess'

const rows = listSessions()          // 只读每个文件的头部帧，420 个会话毫秒级
const stat = await summarize(rows[0].path)
console.log(stat.toolErrors, stat.turnEnd)
```

`listSessions()` 默认读首帧拿 `cwd` / `createdAt`；`{ meta: false }` 时只 stat，最快。

## 环境变量

- `DSH_HOME` —— 会话根目录的父级，默认 `~/.dsh`。

## 许可

MIT
