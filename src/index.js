import { homedir } from 'node:os'
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { readFrames, readJSONLines, findFrameStarts } from 'zstdframes'

export const SESSION_FILE = 'session.v4.jsonl.zstd'

export function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * 只读文件开头若干字节，解出第一条事件（session 头）。
 * 为 `list` 服务：420 个会话全量解压要 25 秒，只读首帧是毫秒级。
 */
export function readFirstEvent(file) {
  let size = 256 * 1024
  for (let attempt = 0; attempt < 5; attempt++) {
    const fd = openSync(file, 'r')
    let buf
    let n
    try {
      buf = Buffer.alloc(size)
      n = readSync(fd, buf, 0, size, 0)
    } finally {
      closeSync(fd)
    }
    const slice = buf.subarray(0, n)
    const starts = findFrameStarts(slice)
    if (starts.length === 0) return null
    const end = starts.length > 1 && starts[1] < n ? starts[1] : n
    try {
      const text = zstdDecompressSync(slice.subarray(starts[0], end)).toString('utf8')
      const line = text.split('\n').find((l) => l.trim())
      if (!line) return null
      return JSON.parse(line)
    } catch {
      size *= 4
      if (size > n + 4 * 1024 * 1024) return null
    }
  }
  return null
}

/** 枚举所有会话，按修改时间倒序 */
export function listSessions({ root = sessionsRoot(), meta = true } = {}) {
  let slugs
  try {
    slugs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }
  const out = []
  for (const slug of slugs) {
    let ids
    try {
      ids = readdirSync(join(root, slug.name), { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const d of ids) {
      const path = join(root, slug.name, d.name, SESSION_FILE)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const rec = {
        id: d.name,
        slug: slug.name,
        path,
        bytes: st.size,
        mtime: st.mtimeMs,
      }
      if (meta) {
        const head = readFirstEvent(path)
        if (head) {
          rec.cwd = head.cwd
          rec.createdAt = head.createdAt
          rec.preset = head.agentPreset
          rec.depth = head.delegationDepth
        }
      }
      out.push(rec)
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** 全量扫描一个会话，产出统计 */
export async function summarize(path) {
  const byType = new Map()
  const turnEnd = new Map()
  const errorByCode = new Map()
  let events = 0
  let toolCalls = 0
  let toolErrors = 0
  let first = null
  let lastTime = null
  const errors = []
  const MAX_KEPT = 2000

  for await (const ev of readJSONLines(path)) {
    if (ev.__frameError || ev.__parseError) continue
    events++
    byType.set(ev.type, (byType.get(ev.type) || 0) + 1)
    if (ev.time) lastTime = ev.time
    if (ev.type === 'session') first = ev
    if (ev.type === 'turn/end') {
      const k = ev.data?.reason?.kind ?? 'unknown'
      turnEnd.set(k, (turnEnd.get(k) || 0) + 1)
    }
    if (ev.type === 'tool/call') toolCalls++
    if (ev.type === 'tool/result') {
      const err = ev.data?.error
      if (err) {
        toolErrors++
        const code = err.code || err.name || 'Error'
        errorByCode.set(code, (errorByCode.get(code) || 0) + 1)
        if (errors.length < MAX_KEPT) {
          errors.push({
            turn: ev.data.turn,
            step: ev.data.step,
            name: err.name || 'Error',
            code: err.code || '',
          })
        }
      }
    }
  }

  return {
    path,
    id: first?.id,
    cwd: first?.cwd,
    createdAt: first?.createdAt,
    lastTime,
    events,
    toolCalls,
    toolErrors,
    errorByCode: Object.fromEntries([...errorByCode.entries()].sort((a, b) => b[1] - a[1])),
    errors,
    turnEnd: Object.fromEntries(turnEnd),
    byType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
  }
}

/** 逐轮时间线 */
export async function turns(path) {
  const rows = []
  let cur = null
  for await (const ev of readJSONLines(path)) {
    if (ev.__frameError || ev.__parseError) continue
    if (ev.type === 'turn/start') {
      cur = { turn: ev.data?.turn ?? rows.length + 1, time: ev.time, steps: 0, toolCalls: 0, toolErrors: 0, end: null, endTime: null }
      rows.push(cur)
    } else if (!cur) continue
    else if (ev.type === 'step/start') cur.steps++
    else if (ev.type === 'tool/call') cur.toolCalls++
    else if (ev.type === 'tool/result' && ev.data?.error) cur.toolErrors++
    else if (ev.type === 'turn/end') {
      cur.end = ev.data?.reason?.kind ?? 'unknown'
      cur.endTime = ev.time
    }
  }
  return rows
}

/**
 * 工具错误 → 提示词/工作流层面的归因。
 * 只写能落到具体动作上的建议，不写「请检查你的提示词」这种废话。
 */
export const ADVICE = {
  FS_NOT_OBSERVED: {
    cause: '编辑前没读文件，宿主用 read-before-edit 策略拒绝',
    action: '在编辑规则里硬性要求「先 read 再 edit」，或让工具返回值里带上文件摘要提示',
  },
  FS_EDIT_NOT_FOUND: {
    cause: 'old_string 与文件现状不一致（文件变了，或凭记忆抄了内容）',
    action: '每次 edit 前重新 read 目标区间；批量改动改用整文件 write',
  },
  FS_STALE_VERSION: {
    cause: '文件在读取与写入之间被改动，版本守卫拒绝写入',
    action: '重新读取后在其上 rebase 再改；并发写同一文件时用互斥的写入范围',
  },
  FS_AMBIGUOUS_EDIT: {
    cause: 'old_string 在文件里出现多次，无法定位',
    action: '扩大 old_string 上下文，或改用带行号/唯一锚点的写法',
  },
  FS_NOT_FOUND: {
    cause: '路径不存在（拼错、相对路径基准搞错、还没创建）',
    action: '先用 glob/grep 确认路径存在；相对路径统一以工作目录为基准',
  },
  FS_NOT_TEXT: {
    cause: '把二进制/非 UTF-8 文件当文本读',
    action: '先用 file 类型判断，二进制走专用读取器',
  },
  INVALID_ARGS: {
    cause: '工具参数不符合 schema（字面量太短、字段漏填、非法枚举）',
    action: '把 schema 约束写进工具描述，长脚本改走 script_path 而不是塞进 command',
  },
  TOOL_TIMEOUT: {
    cause: '单条命令超时',
    action: '拆分长任务、后台跑 job，或把大扫描改成有界查询',
  },
  TOOL_OUTCOME_UNKNOWN: {
    cause: '命令中断且无法确认副作用是否发生',
    action: '下一步先做后置检查（文件/进程/端口），不要直接重试',
  },
  ABORTED: {
    cause: '用户中断或会话被打断',
    action: '正常现象；若集中在某类工具上，说明该工具太慢',
  },
}

/** 把一次会话的工具错误归因成可执行的改进项 */
export async function diagnose(path) {
  const r = await summarize(path)
  const byCode = new Map()
  for (const [code, count] of Object.entries(r.errorByCode)) {
    byCode.set(code, { key: code, name: code.split(':')[0], count, turns: new Set() })
  }
  for (const e of r.errors) {
    const cur = byCode.get(e.code || e.name)
    if (cur) cur.turns.add(e.turn)
  }
  const items = [...byCode.values()]
    .map((v) => ({
      key: v.key,
      name: v.name,
      count: v.count,
      turns: [...v.turns].sort((a, b) => a - b),
      share: r.toolCalls ? v.count / r.toolCalls : 0,
      ...(ADVICE[v.key] || { cause: '未归类', action: '先看原始 tool/result 确认语义' }),
    }))
    .sort((a, b) => b.count - a.count)

  // 同一轮里同一种错犯 3 次以上 = 模型在原地打转，比总量更值得看
  const loops = []
  const perTurn = new Map()
  for (const e of r.errors) {
    const k = `${e.turn}|${e.code || e.name}`
    perTurn.set(k, (perTurn.get(k) || 0) + 1)
  }
  for (const [k, n] of perTurn) {
    if (n >= 3) {
      const [turn, code] = k.split('|')
      loops.push({ turn: Number(turn), code, count: n })
    }
  }
  loops.sort((a, b) => b.count - a.count)

  return {
    id: r.id,
    cwd: r.cwd,
    toolCalls: r.toolCalls,
    toolErrors: r.toolErrors,
    turnEnd: r.turnEnd,
    items,
    loops,
  }
}

export { readFrames, readJSONLines }
