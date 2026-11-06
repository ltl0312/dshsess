import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { listSessions, summarize, turns, readFirstEvent, sessionsRoot } from '../src/index.js'

function frame(obj) {
  return zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
}

/** 造一棵假的 ~/.dsh/sessions 树 */
function makeHome(sessions) {
  const home = mkdtempSync(join(tmpdir(), 'dshsess-'))
  for (const s of sessions) {
    const dir = join(home, 'sessions', s.slug, s.id)
    mkdirSync(dir, { recursive: true })
    const parts = s.events.map(frame)
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(parts))
  }
  return home
}

const okSession = {
  slug: '--D-Code-demo--',
  id: 'session-aaaa',
  events: [
    { type: 'session', version: 4, id: 'session-aaaa', createdAt: 1792656450179, cwd: 'D:\\Code\\demo', agentPreset: 'standard', delegationDepth: 0 },
    { type: 'turn/start', seq: 1, time: 1792656451000, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1792656451100, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 3, time: 1792656451200, data: { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: '{}' } },
    { type: 'tool/result', seq: 4, time: 1792656451900, data: { turn: 1, step: 1, message: { role: 'tool' }, meta: { opsShell: { exitCode: 0 } } } },
    { type: 'turn/end', seq: 5, time: 1792656453000, data: { turn: 1, reason: { kind: 'completed' } } },
  ],
}

const badSession = {
  slug: '--D-Code-demo--',
  id: 'session-bbbb',
  events: [
    { type: 'session', version: 4, id: 'session-bbbb', createdAt: 1792656460000, cwd: 'D:\\Code\\other', agentPreset: 'standard', delegationDepth: 0 },
    { type: 'turn/start', seq: 1, time: 1792656461000, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 1792656461200, data: { turn: 1, step: 1, callId: 'c1', name: 'ops_edit', arguments: '{}' } },
    { type: 'tool/result', seq: 3, time: 1792656461500, data: { turn: 1, step: 1, message: { role: 'tool' }, error: { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' } } },
    { type: 'turn/end', seq: 4, time: 1792656463000, data: { turn: 1, reason: { kind: 'error' } } },
  ],
}

test('sessionsRoot 尊重 DSH_HOME', () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\fake\\dsh'
  assert.equal(sessionsRoot(), join('C:\\fake\\dsh', 'sessions'))
  if (old === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = old
})

test('readFirstEvent 只解首帧就能拿到 session 头', () => {
  const home = makeHome([okSession])
  const p = join(home, 'sessions', okSession.slug, okSession.id, 'session.v4.jsonl.zstd')
  const head = readFirstEvent(p)
  assert.equal(head.id, 'session-aaaa')
  assert.equal(head.cwd, 'D:\\Code\\demo')
})

test('listSessions 按修改时间倒序并带出 cwd', () => {
  const home = makeHome([okSession, badSession])
  const rows = listSessions({ root: join(home, 'sessions') })
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.cwd))
})

test('summarize 统计工具错误与 turn 结束原因', async () => {
  const home = makeHome([badSession])
  const p = join(home, 'sessions', badSession.slug, badSession.id, 'session.v4.jsonl.zstd')
  const r = await summarize(p)
  assert.equal(r.toolCalls, 1)
  assert.equal(r.toolErrors, 1)
  assert.equal(r.errors[0].code, 'FS_EDIT_NOT_FOUND')
  assert.deepEqual(r.turnEnd, { error: 1 })
})

test('turns 产出逐轮时间线', async () => {
  const home = makeHome([okSession])
  const p = join(home, 'sessions', okSession.slug, okSession.id, 'session.v4.jsonl.zstd')
  const rows = await turns(p)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].turn, 1)
  assert.equal(rows[0].toolCalls, 1)
  assert.equal(rows[0].end, 'completed')
  assert.equal(rows[0].endTime - rows[0].time, 2000)
})
