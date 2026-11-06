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
  let events = 0
  let toolCalls = 0
  let toolErrors = 0
  let first = null
  let lastTime = null
  const errors = []

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
        if (errors.length < 200) {
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

export { readFrames, readJSONLines }
