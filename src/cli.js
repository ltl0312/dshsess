#!/usr/bin/env node
import { readJSONLines } from 'zstdframes'
import { listSessions, summarize, turns, sessionsRoot, diagnose } from './index.js'

const USAGE = `dshsess — DSH 会话日志考古

  dshsess list    [--limit 20] [--since YYYY-MM-DD] [--cwd <substr>] [--json]
  dshsess stats   [--limit 200]
  dshsess show    <session-id-prefix> [--turns] [--types]
  dshsess failures <session-id-prefix>
  dshsess advice  <session-id-prefix>     归因：这些工具错误说明提示词/工作流哪里漏了
  dshsess grep    <pattern> [--session <prefix>] [--limit 40]

会话目录: ${sessionsRoot()}（可用 DSH_HOME 覆盖）
`

function parse(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--limit') a.limit = Number(argv[++i])
    else if (t === '--since') a.since = argv[++i]
    else if (t === '--cwd') a.cwd = argv[++i]
    else if (t === '--session') a.session = argv[++i]
    else if (t === '--json') a.json = true
    else if (t === '--turns') a.turns = true
    else if (t === '--types') a.types = true
    else if (t === '-h' || t === '--help') a.help = true
    else a._.push(t)
  }
  return a
}

const args = parse(process.argv.slice(2))
const [cmd, arg] = args._

if (args.help || !cmd) {
  process.stdout.write(USAGE)
  process.exit(cmd ? 0 : 2)
}

const mb = (n) => (n / 1048576).toFixed(1)
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const shortCwd = (c) => (c ? c.replace(/^[A-Za-z]:\\/, '').split('\\').slice(-2).join('\\') : '?')

const bare = (id) => id.replace(/^session-/, '')

function pick(prefix) {
  if (!prefix) return null
  const all = listSessions({ meta: false })
  // 用户习惯只打哈希前缀（8b1a3304），目录名带 session- 前缀，两种都认
  const hit = all.filter((s) => s.id.startsWith(prefix) || bare(s.id).startsWith(bare(prefix)))
  if (hit.length === 0) {
    process.stderr.write(`no session matching "${prefix}"\n`)
    process.exit(2)
  }
  if (hit.length > 1) {
    process.stderr.write(`ambiguous "${prefix}": ${hit.map((s) => s.id.slice(0, 12)).join(', ')}\n`)
    process.exit(2)
  }
  return hit[0]
}

if (cmd === 'list') {
  let rows = listSessions({ meta: true })
  if (args.since) {
    const t = Date.parse(args.since)
    rows = rows.filter((s) => (s.createdAt || s.mtime) >= t)
  }
  if (args.cwd) rows = rows.filter((s) => (s.cwd || '').toLowerCase().includes(args.cwd.toLowerCase()))
  rows.sort((a, b) => (b.createdAt || b.mtime) - (a.createdAt || a.mtime))
  rows = rows.slice(0, args.limit ?? 20)
  if (args.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
  } else {
    process.stdout.write('when       size    id          workspace\n')
    for (const s of rows) {
      const when = new Date(s.createdAt || s.mtime).toISOString().slice(0, 16).replace('T', ' ')
      process.stdout.write(`${when} ${mb(s.bytes).padStart(7)} MB  ${s.id.slice(0, 12)}  ${shortCwd(s.cwd)}\n`)
    }
    process.stdout.write(`\n${rows.length} sessions\n`)
  }
} else if (cmd === 'stats') {
  const all = listSessions({ meta: true })
  const byWs = new Map()
  let totalEvents = 0
  let totalBytes = 0
  for (const s of all) {
    totalBytes += s.bytes
    const k = s.cwd || s.slug
    const cur = byWs.get(k) || { sessions: 0, bytes: 0, last: 0 }
    cur.sessions++
    cur.bytes += s.bytes
    cur.last = Math.max(cur.last, s.createdAt || s.mtime)
    byWs.set(k, cur)
    try {
      const r = await summarize(s.path)
      totalEvents += r.events
    } catch {}
  }
  const rows = [...byWs.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
  process.stdout.write('sessions  size      last        workspace\n')
  for (const [k, v] of rows) {
    process.stdout.write(`${String(v.sessions).padStart(8)}  ${mb(v.bytes).padStart(6)} MB  ${day(v.last)}  ${k}\n`)
  }
  process.stdout.write(`\ntotal: ${all.length} sessions, ${mb(totalBytes)} MB, ${totalEvents} events\n`)
} else if (cmd === 'show') {
  const s = pick(arg)
  const head = (await summarize(s.path))
  process.stdout.write(`session   ${head.id}\ncwd       ${head.cwd}\ncreated   ${head.createdAt ? new Date(head.createdAt).toISOString() : '?'}\nevents    ${head.events}\ntools     ${head.toolCalls} calls, ${head.toolErrors} errors\nturns     ${JSON.stringify(head.turnEnd)}\n`)
  if (args.turns) {
    const rows = await turns(s.path)
    process.stdout.write('\nturn  steps  tools  errors  end        duration\n')
    for (const r of rows) {
      const dur = r.time && r.endTime ? `${((r.endTime - r.time) / 1000).toFixed(0)}s` : '-'
      process.stdout.write(`${String(r.turn).padStart(4)}  ${String(r.steps).padStart(5)}  ${String(r.toolCalls).padStart(5)}  ${String(r.toolErrors).padStart(6)}  ${(r.end || '…').padEnd(10)} ${dur}\n`)
    }
  }
  if (args.types) {
    process.stdout.write('\nevent type            count\n')
    for (const [k, v] of Object.entries(head.byType)) process.stdout.write(`${k.padEnd(22)}${v}\n`)
  }
} else if (cmd === 'failures') {
  const s = pick(arg)
  const r = await summarize(s.path)
  process.stdout.write(`session ${r.id} — ${r.toolErrors} tool errors / ${r.toolCalls} calls\n\n`)
  const agg = new Map()
  for (const e of r.errors) {
    const k = `${e.name}:${e.code}`
    agg.set(k, (agg.get(k) || 0) + 1)
  }
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${String(v).padStart(4)}x  ${k}\n`)
  }
  const shown = r.errors.slice(-(args.limit ?? 15))
  if (shown.length) {
    process.stdout.write('\n最近几次:\n')
    for (const e of shown) process.stdout.write(`  turn ${e.turn} step ${e.step}  ${e.name} ${e.code}\n`)
  }
} else if (cmd === 'advice') {
  const s = pick(arg)
  const d = await diagnose(s.path)
  const pct = (x) => (x * 100).toFixed(2) + '%'
  process.stdout.write(`session ${d.id}\n${d.cwd}\n${d.toolErrors} errors / ${d.toolCalls} calls = ${pct(d.toolErrors / (d.toolCalls || 1))}\n`)
  process.stdout.write(`turns     ${JSON.stringify(d.turnEnd)}\n`)
  if (!d.items.length) {
    process.stdout.write('\n没有工具错误。\n')
  } else {
    process.stdout.write('\n#  错误码                       次数   占比    归因 → 动作\n')
    d.items.forEach((it, i) => {
      process.stdout.write(`${String(i + 1).padStart(2)} ${it.key.padEnd(28)} ${String(it.count).padStart(4)}  ${pct(it.share).padStart(6)}\n`)
      process.stdout.write(`     归因  ${it.cause}\n`)
      process.stdout.write(`     动作  ${it.action}\n`)
      if (it.turns.length) process.stdout.write(`     轮次  ${it.turns.slice(0, 12).join(', ')}${it.turns.length > 12 ? ` …(+${it.turns.length - 12})` : ''}\n`)
    })
  }
  if (d.loops.length) {
    process.stdout.write('\n# 原地打转（同一轮同类错误 ≥3 次）\n')
    for (const l of d.loops.slice(0, 8)) process.stdout.write(`  turn ${String(l.turn).padStart(3)}  ${l.code} ×${l.count}\n`)
  }
} else if (cmd === 'grep') {
  if (!arg) {
    process.stderr.write('grep 需要 pattern\n')
    process.exit(2)
  }
  const re = new RegExp(arg, 'i')
  const targets = args.session ? [pick(args.session)] : listSessions({ meta: false }).slice(0, args.limit ?? 40)
  let hits = 0
  for (const s of targets) {
    for await (const ev of readJSONLines(s.path)) {
      if (ev.__frameError || ev.__parseError) continue
      const text = JSON.stringify(ev.data ?? {})
      if (!re.test(text)) continue
      hits++
      const snippet = text.length > 160 ? text.slice(0, 160) + '…' : text
      process.stdout.write(`${bare(s.id).slice(0, 8)}  ${ev.type.padEnd(18)} ${snippet}\n`)
      if (hits >= (args.limit ?? 40)) process.exit(0)
    }
  }
  process.stdout.write(`\n${hits} hits\n`)
} else {
  process.stderr.write(`unknown command: ${cmd}\n\n` + USAGE)
  process.exit(2)
}
