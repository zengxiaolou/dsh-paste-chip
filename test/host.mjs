/**
 * 宿主半的落盘验证：真起一个 apply，走真实的 HTTP handler 契约，最后真读文件。
 *
 * 与 harness.mjs 的分工：
 *   harness.mjs → 客户端逻辑（替身 DOM/React/fetch）
 *   host.mjs    → 宿主逻辑（真实 fs，只替身 ctx.webServer 与 req/res）
 *
 * 跑法：node test/host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 指向临时 HOME，避免污染真实日志
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-paste-chip-host-'))
process.env.DSH_HOME = sandbox

const { apply, inject } = await import(fileURLToPath(new URL('../lib/index.js', import.meta.url)))

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** 收集注册的路由，供测试直接调用 handler。 */
function mount() {
  const routes = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: { info: line => logs.push(line) },
    effect: fn => { effects.push(fn); return fn() },
    webServer: {
      register: ({ kind, path, handler }) => {
        assert.equal(kind, 'exact')
        routes.set(path, handler)
        return () => {}
      },
    },
  }
  apply(ctx)
  return { routes, logs, effects }
}

/** 伪造 Node 的 req：可异步迭代、带 method。 */
function fakeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 伪造 res：记录状态码与响应体。 */
function fakeResponse() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead: (status, headers) => { out.status = status; out.headers = headers },
    end: (payload) => { out.body = payload },
  }
}

const logFile = join(sandbox, 'logs', 'dsh-paste-chip.log')

await check('apply 写出 host.boot，文件真实存在', () => {
  mount()
  assert.ok(existsSync(logFile), `日志文件应存在：${logFile}`)
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const boot = lines.find(line => line.ev === 'host.boot')
  assert.ok(boot !== undefined, '应有 host.boot 行')
  assert.equal(boot.src, 'host')
  assert.match(boot.version, /^\d+\.\d+\.\d+$/)
  assert.equal(boot.logFile, logFile)
})

await check('inject 声明了 webServer（没有它挂不上路由）', () => {
  assert.deepEqual(inject, ['webServer'])
})

await check('POST 事件批量落盘，字段按原样保留', async () => {
  const { routes } = mount()
  const handler = routes.get('/api/dsh-paste-chip/log')
  assert.ok(typeof handler === 'function', '应注册日志路由')

  const req = fakeRequest('POST', JSON.stringify({
    events: [
      { level: 'info', ev: 'paste.seen', data: { chars: 1500, collapses: true } },
      { level: 'info', ev: 'paste.outcome', data: { outcome: 'chip' } },
    ],
  }))
  const res = fakeResponse()
  await handler(req, res)

  assert.equal(res.out.status, 200)
  const body = JSON.parse(res.out.body)
  assert.equal(body.accepted, 2)

  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const seen = lines.filter(line => line.src === 'client' && line.ev === 'paste.seen').at(-1)
  assert.ok(seen !== undefined, '客户端事件应落到文件里')
  assert.equal(seen.data.chars, 1500)
  assert.ok(typeof seen.t === 'string', '每行都要有时间戳')
})

await check('GET 返回落点与体积，便于不进文件先确认', async () => {
  const { routes } = mount()
  const handler = routes.get('/api/dsh-paste-chip/log')
  const res = fakeResponse()
  await handler(fakeRequest('GET'), res)
  assert.equal(res.out.status, 200)
  const body = JSON.parse(res.out.body)
  assert.equal(body.logFile, logFile)
  assert.ok(body.bytes > 0)
})

await check('坏 JSON 不静默：返回 400 并在文件里留 log.reject', async () => {
  const { routes } = mount()
  const handler = routes.get('/api/dsh-paste-chip/log')
  const res = fakeResponse()
  await handler(fakeRequest('POST', '{not json'), res)
  assert.equal(res.out.status, 400)
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(lines.some(line => line.ev === 'log.reject'), '解析失败必须留痕')
})

await check('非 POST/GET 方法被拒绝', async () => {
  const { routes } = mount()
  const handler = routes.get('/api/dsh-paste-chip/log')
  const res = fakeResponse()
  await handler(fakeRequest('DELETE'), res)
  assert.equal(res.out.status, 405)
})

await check('超限轮转：文件超过 4MB 时轮转一份 .1', async () => {
  const { routes } = mount()
  const handler = routes.get('/api/dsh-paste-chip/log')
  // 直接把文件撑过阈值，再写一条触发轮转
  writeFileSync(logFile, 'x'.repeat(4 * 1024 * 1024 + 10))
  const res = fakeResponse()
  await handler(fakeRequest('POST', JSON.stringify({ events: [{ ev: 'after.rotate' }] })), res)
  assert.ok(existsSync(`${logFile}.1`), '应产生轮转文件')
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(lines.some(line => line.ev === 'after.rotate'), '轮转后仍要能写入')
})

console.log(results.join('\n'))
const failed = results.filter(line => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
