/**
 * dsh-paste-chip 的离线验证：不开 DSH、不碰真实 UI，用替身驱动真实的 lib/client.js。
 *
 * 覆盖三条链路：
 *   1. 折叠阈值与计数（纯逻辑）
 *   2. 粘贴拦截 → actx.bail 插入 chip → 发送时 codec.serialize 展开正文（含失败回退）
 *   3. 插件装配：registerSource 的契约字段、槽位注册、会话 actx 解析
 *
 * 跑法：node test/harness.mjs
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 替身：localStorage / document / navigator / window.__ModuleLoader__
 * ------------------------------------------------------------------ */
const backing = new Map()
globalThis.localStorage = {
  getItem: key => (backing.has(key) ? backing.get(key) : null),
  setItem: (key, value) => { backing.set(key, String(value)) },
  removeItem: key => { backing.delete(key) },
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

const listeners = new Map()
const fakeEditor = { contains: () => true }
globalThis.document = {
  addEventListener: (type, fn) => { listeners.set(type, fn) },
  removeEventListener: (type) => { listeners.delete(type) },
  querySelector: selector => (selector.includes('data-lexical-editor') ? fakeEditor : null),
}

let loaded = null
const windowListeners = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load(module) { loaded = module },
  },
  addEventListener: (type, fn) => { windowListeners.set(type, fn) },
}
// fetch 替身：记录每次上报，供断言日志批次
const posted = []
globalThis.fetch = (url, init) => {
  posted.push({ url, body: init && init.body ? JSON.parse(init.body) : null })
  // 配置接口返回一份「用户改过」的配置，用来验证客户端会用它覆盖默认值
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, config: { collapseChars: 1200 } }) })
}

/* 替身 React：effect 排队手动跑，state 记录写入值，ref 直接给对象。 */
const effectQueue = []
const stateWrites = []
// 真实 React 的 hook 会跨渲染保留，替身必须照做，否则 useRef 在两次渲染间会丢状态。
const hookStore = []
let hookIndex = 0
function resetHooks({ clear = false } = {}) {
  hookIndex = 0
  if (clear) hookStore.length = 0
}
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useRef: (initial) => {
    const slot = hookIndex++
    if (hookStore[slot] === undefined) hookStore[slot] = { current: initial }
    return hookStore[slot]
  },
  useState: (initial) => {
    const slot = hookIndex++
    if (hookStore[slot] === undefined) hookStore[slot] = [initial, value => { stateWrites.push(value) }]
    return hookStore[slot]
  },
  // deps 为空数组 = 只跑一次（真实 React 语义）；否则每次渲染都跑。
  useEffect: (fn, deps) => {
    const slot = hookIndex++
    const once = Array.isArray(deps) && deps.length === 0
    const record = hookStore[slot]
    if (record === undefined) hookStore[slot] = { ran: true, once }
    else if (once && record.ran) return
    else record.ran = true
    effectQueue.push(fn)
  },
}

/** 渲染一次组件并立刻跑完它的 effect（等价于一次 commit）。 */
function renderHost(props) {
  resetHooks()
  effectQueue.length = 0
  __internals.PasteHost(props)
  for (const run of effectQueue.splice(0)) run()
}

await import(fileURLToPath(new URL('../lib/client.js', import.meta.url)))
assert.ok(loaded !== null, '客户端包应当调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-paste-chip')

const mod = loaded.factory(id => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
})
const { apply, inject, __internals } = mod
assert.deepEqual(inject, ['slots', 'sessions', 'inputTriggers', 'locale'])

const results = []
const pendingChecks = []
function check(name, fn) {
  try {
    const returned = fn()
    if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
      // 异步用例：统一在这里收口，避免断言失败变成 unhandled rejection。
      const previous = pendingChecks.at(-1) ?? Promise.resolve()
      pendingChecks.push(previous.then(() => returned).then(
        () => { results.push(`PASS ${name}`) },
        (error) => { results.push(`FAIL ${name}: ${error.message}`); process.exitCode = 1 },
      ))
      return
    }
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ *
 * 1. 阈值与计数
 * ------------------------------------------------------------------ */
const { shouldCollapse, compactCount, collapsePaste, readBody, writeBody, SOURCE, detectInsertion,
  DEFAULT_SETTINGS, getSettings, normalizeSettings } = __internals
const MAX_CHARS = DEFAULT_SETTINGS.maxChars
const COLLAPSE_CHARS = DEFAULT_SETTINGS.collapseChars
const COLLAPSE_LINES = DEFAULT_SETTINGS.collapseLines

check(`阈值是 ${COLLAPSE_CHARS} 字符 / ${COLLAPSE_LINES} 行`, () => {
  assert.equal(COLLAPSE_CHARS, 400, '阈值应为 400 字')
  assert.equal(shouldCollapse('x'.repeat(COLLAPSE_CHARS - 1)), false)
  assert.equal(shouldCollapse('x'.repeat(COLLAPSE_CHARS)), true)
  const lines = n => Array.from({ length: n }, () => 'y').join('\n')
  assert.equal(shouldCollapse(lines(COLLAPSE_LINES - 1)), false)
  assert.equal(shouldCollapse(lines(COLLAPSE_LINES)), true)
})
check('计数压缩', () => {
  assert.equal(compactCount(980), '980')
  assert.equal(compactCount(1200), '1.2k')
  assert.equal(compactCount(200000), '200k')
})

/* ------------------------------------------------------------------ *
 * 2. 折叠流程
 * ------------------------------------------------------------------ */
check('短粘贴直接放行', () => {
  let touched = false
  const outcome = collapsePaste('short', {
    captureInsertion: () => { touched = true; return { start: 0, end: 0, draftRev: 1 } },
    insertChip: () => { touched = true; return true },
    insertText: () => { touched = true },
    notify: () => { touched = true },
  })
  assert.equal(outcome, 'pass')
  assert.equal(touched, false, '放行路径不应碰任何通道')
})

check('长粘贴写成 chip 且正文可按 ref 取回', () => {
  const body = '长文本段落。'.repeat(200)
  const calls = []
  const outcome = collapsePaste(body, {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 7 }),
    insertChip: (reference, span) => { calls.push({ reference, span }); return true },
    insertText: () => { throw new Error('不应回退') },
    notify: () => { throw new Error('不应提示') },
  })
  assert.equal(outcome, 'chip')
  assert.equal(calls.length, 1)
  const [{ reference, span }] = calls
  assert.equal(reference.source, SOURCE)
  assert.equal(reference.appearance, 'file')
  assert.match(reference.label, /粘贴「.+」· \d/)
  assert.equal(reference.clipboardText, reference.label)
  assert.deepEqual(span, { start: 0, end: 0, draftRev: 7 })
  assert.ok(reference.ref.length < 32, `ref 必须是短 id，实际 ${reference.ref.length} 字符`)
  assert.equal(readBody(reference.ref), body, '正文要能按 ref 取回')
  assert.ok(!reference.ref.includes('长'), 'ref 里不能夹正文')
})

check('chip 插入失败时回退纯文本，绝不吞内容', () => {
  const body = 'z'.repeat(5000)
  const notes = []
  let inserted = null
  let ref = null
  const outcome = collapsePaste(body, {
    captureInsertion: () => ({ start: 1, end: 2, draftRev: 3 }),
    insertChip: (reference) => { ref = reference.ref; return false },
    insertText: (text) => { inserted = text },
    notify: text => { notes.push(text) },
  })
  assert.equal(outcome, 'fallback')
  assert.equal(inserted, body)
  assert.equal(notes.length, 1)
  assert.equal(readBody(ref), null, '回退后不应留下孤儿正文')
})

check('超过上限直接拒绝，不写存储不外发', () => {
  const body = 'a'.repeat(MAX_CHARS + 1)
  const notes = []
  let touched = false
  const outcome = collapsePaste(body, {
    captureInsertion: () => { touched = true; return null },
    insertChip: () => { touched = true; return true },
    insertText: () => { touched = true },
    notify: text => { notes.push(text) },
  })
  assert.equal(outcome, 'refused')
  assert.equal(touched, false)
  assert.match(notes[0], /超过输入框上限/)
})

/* ------------------------------------------------------------------ *
 * 3. DOM 拦截 + 插件装配
 * ------------------------------------------------------------------ */
check('DOM 粘贴：只拦长文本，短文本不 preventDefault', () => {
  resetHooks({ clear: true })
  renderHost({ inputActions: {}, pasteChipActx: {} })

  const handler = listeners.get('paste')
  assert.ok(typeof handler === 'function', '应当在 document 捕获阶段注册监听')

  let prevented = false
  handler({
    target: {},
    clipboardData: { getData: () => 'short text' },
    preventDefault: () => { prevented = true },
    stopPropagation: () => {},
  })
  assert.equal(prevented, false, '短粘贴必须放行给 core')
})

check('DOM 粘贴：长文本走 bail 插入 chip，payload 契约正确', () => {
  const bailCalls = []
  const actions = {
    captureInsertion: () => ({ start: 4, end: 4, draftRev: 11 }),
    insertText: () => { throw new Error('不应回退') },
  }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }

  resetHooks({ clear: true })
  renderHost({ inputActions: actions, pasteChipActx: actx })
  const handler = listeners.get('paste')

  let prevented = false
  const body = '正文'.repeat(800)
  handler({
    target: {},
    clipboardData: { getData: () => body },
    preventDefault: () => { prevented = true },
    stopPropagation: () => {},
  })

  assert.equal(prevented, true, '长粘贴必须自己接管')
  assert.equal(bailCalls.length, 1)
  const [subject, event, request] = bailCalls[0]
  assert.equal(subject, actx)
  assert.equal(event, 'slash/input-insert-reference')
  assert.equal(request.reference.source, SOURCE)
  assert.deepEqual(request.span, { start: 4, end: 4, draftRev: 11 })
  assert.equal(readBody(request.reference.ref), body)
})

check('装配：注册的引用来源能被 serialize 展开，缺失时明确失败', async () => {
  const sources = []
  const slots = []
  const ctx = {
    effect: fn => { fn() },
    inject: (_names, fn) => { fn() },
    inputTriggers: { registerSource: src => { sources.push(src); return () => {} } },
    sessions: { scope: id => ({ id }) },
    slots: {
      inject: (_name, fn) => { fn() },
      register: (desc, component) => { slots.push({ desc, component }); return () => {} },
    },
  }
  apply(ctx)

  assert.equal(sources.length, 1)
  const source = sources[0]
  assert.equal(source.name, SOURCE)
  assert.equal(typeof source.codec.serialize, 'function')
  // 两个槽位：悬停预览宿主 + 工具行托盘入口
  assert.equal(slots.length, 2)
  const overlay = slots.find(slot => slot.desc.name === 'conversation.input.overlay')
  const tray = slots.find(slot => slot.desc.name === 'conversation.input.left')
  assert.ok(overlay !== undefined, '应注册 conversation.input.overlay')
  assert.ok(tray !== undefined, '应注册 conversation.input.left')
  assert.equal(overlay.component, __internals.PasteHost)

  const body = '要展开的正文'.repeat(100)
  const ref = writeBody(body)
  assert.equal(await source.codec.serialize(ref), body, '发送时必须展开成完整正文')

  let rejected = null
  try {
    await source.codec.serialize('c-missing')
  } catch (error) {
    rejected = error
  }
  assert.ok(rejected !== null, '正文缺失必须拒绝发送，而不是发标签')
  assert.match(rejected.message, /重新粘贴/)
})

check('从草稿差异里认出程序化插入（标注浏览器/划词询问走这条）', () => {
  // 纯追加：常见于标注浏览器把备注追到草稿末尾
  const appended = detectInsertion('原有内容', '原有内容' + 'x'.repeat(500))
  assert.equal(appended.start, 4)
  assert.equal(appended.end, 504)
  assert.equal(appended.removed, 0)
  assert.equal(appended.text.length, 500)

  // 插到中间/开头也一样能定位
  const prepended = detectInsertion('尾部', 'x'.repeat(300) + '尾部')
  assert.equal(prepended.start, 0)
  assert.equal(prepended.removed, 0)
  assert.equal(prepended.text.length, 300)

  // 替换（有删除）：调用方据此跳过，不接管
  const replaced = detectInsertion('a'.repeat(10), 'a'.repeat(10) + 'b'.repeat(400).slice(0, 400))
  assert.equal(replaced.removed, 0)
  const shrunk = detectInsertion('a'.repeat(500), 'a'.repeat(10))
  assert.equal(shrunk, null, '变短不算插入')

  // 无变化 / 非法输入
  assert.equal(detectInsertion('same', 'same'), null)
  assert.equal(detectInsertion(undefined, 'x'), null)
})

/* ------------------------------------------------------------------ *
 * 3.5 悬停预览：正文前缀与「第 N 个胶囊 → ref」的映射
 * ------------------------------------------------------------------ */
const { tooltipModel, refAtIndex } = __internals
const TOOLTIP_PREVIEW_CHARS = DEFAULT_SETTINGS.previewChars

check('短正文不截断，长正文截断并带省略号', () => {
  const short = tooltipModel('一小段', '粘贴文本 · 3 字')
  assert.equal(short.truncated, false)
  assert.equal(short.preview, '一小段')
  assert.equal(short.total, 3)

  const body = 'x'.repeat(TOOLTIP_PREVIEW_CHARS + 50)
  const long = tooltipModel(body, '粘贴文本 · 370 字')
  assert.equal(long.truncated, true)
  assert.equal(long.preview.length, TOOLTIP_PREVIEW_CHARS + 1)
  assert.ok(long.preview.endsWith('…'), '截断要有省略号')
  assert.equal(long.total, TOOLTIP_PREVIEW_CHARS + 50)
})

check('chip 插入成功时把 label→ref 记下来，供悬停兜底', () => {
  const seen = []
  const body = '兜底记录'.repeat(300)
  const outcome = collapsePaste(body, {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertChip: () => true,
    insertText: () => {},
    notify: () => {},
    onInserted: (ref, label) => { seen.push({ ref, label }) },
  })
  assert.equal(outcome, 'chip')
  assert.equal(seen.length, 1)
  assert.match(seen[0].label, /^粘贴「.+」· /)
  assert.equal(readBody(seen[0].ref), body, '记下的 ref 必须能取回正文')
})

check('胶囊序号能映射到自己的 ref，且只认本来源', () => {
  const occurrences = [
    { source: 'file', ref: 'src/a.ts' },
    { source: SOURCE, ref: 'ref-0' },
    { source: SOURCE, ref: 'ref-1' },
  ]
  assert.equal(refAtIndex(occurrences, 0), 'ref-0', '别的来源不能占位')
  assert.equal(refAtIndex(occurrences, 1), 'ref-1')
  assert.equal(refAtIndex(occurrences, 2), undefined, '越界返回 undefined')
  assert.equal(refAtIndex(undefined, 0), undefined, '没有 occurrences 也不能炸')
})

check('程序化写入的长文本也会变成胶囊（标注浏览器 / 划词询问）', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }

  const realNow = Date.now
  let clock = 5_000_000
  Date.now = () => clock
  try {
    // 第一帧：空草稿，观察器只记录基线
    resetHooks({ clear: true })
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '', occurrences: [], draftRev: 1 }) })

    // 越过预热窗口，再让外部插件把 600 字塞进草稿（不经过 paste）
    clock += 5000
    const injected = 'x'.repeat(600)
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: injected, occurrences: [], draftRev: 2 }) })

  assert.equal(bailCalls.length, 1, '应当用 bail 把它换成胶囊')
  const [, event, request] = bailCalls[0]
  assert.equal(event, 'slash/input-insert-reference')
  assert.equal(request.reference.source, SOURCE)
  assert.deepEqual(request.span, { start: 0, end: 600, draftRev: 2 })
  assert.equal(readBody(request.reference.ref), injected, '正文要能取回')
    assert.match(request.reference.label, /600 字/, '标签应带 600 字')
  } finally {
    Date.now = realNow
  }
})

check('两个同字数、不同内容的胶囊标签必须可区分', () => {
  const { chipLabel } = __internals
  const a = chipLabel('会议纪要：本周三下午三点在 A 会议室'.repeat(20))
  const b = chipLabel('报错日志：TypeError cannot read property'.repeat(20))
  assert.notEqual(a, b, '同字数但内容不同的胶囊不能长得一样')
  assert.match(a, /^粘贴「/)
  assert.match(a, /字$/)
})

check('悬停上下文：能取到胶囊前后各一段', () => {
  const { contextOf } = __internals
  const input = {
    draft: '前面一句在这里，粘贴内容在这里，后面一句在这里',
    occurrences: [{ source: SOURCE, ref: 'r1', offset: 8, length: 7 }],
  }
  const ctx = contextOf(input, 0)
  assert.ok(ctx !== null, '应当取到上下文')
  assert.equal(ctx.before, '前面一句在这里，')
  assert.equal(ctx.after, '，后面一句在这里')
  // 没有 occurrences / 没有 draft 时返回 null，不能炸
  assert.equal(contextOf(undefined, 0), null)
  assert.equal(contextOf({ draft: '', occurrences: [] }, 0), null)
})

check('回归：单个字不能被折叠成胶囊（日志里 7 次误折叠全是 1 字）', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }

  const realNow = Date.now
  let clock = 10_000_000
  Date.now = () => clock
  try {
    resetHooks({ clear: true })
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '', occurrences: [], draftRev: 1 }) })
    clock += 5000
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '好', occurrences: [], draftRev: 2 }) })
  } finally {
    Date.now = realNow
  }
  assert.equal(bailCalls.length, 0, '一个字绝对不能变胶囊')
  const skip = __internals.pendingLogs().filter(entry => entry.ev === 'insertion.skip' && entry.data.reason === 'too-short').at(-1)
  assert.ok(skip !== undefined, '应记录 too-short 跳过原因')
})

check('输入法路径：只要 input 事件到过，也不折叠', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }

  const realNow = Date.now
  let clock = 11_000_000
  Date.now = () => clock
  try {
    resetHooks({ clear: true })
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '', occurrences: [], draftRev: 1 }) })
    clock += 5000
    // 模拟输入法提交：没有 beforeinput，只有 input
    listeners.get('input')?.()
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '这是一段用输入法打出来的文字', occurrences: [], draftRev: 2 }) })
  } finally {
    Date.now = realNow
  }
  assert.equal(bailCalls.length, 0, '输入法提交不能被折叠')
})

check('外部渠道的短文本也直接成胶囊（不看字数/行数）', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }

  const realNow = Date.now
  let clock = 8_000_000
  Date.now = () => clock
  try {
    resetHooks({ clear: true })
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '', occurrences: [], draftRev: 1 }) })
    clock += 5000
    const short = '一条只有十几个字的短注释'  // 13 字，高于 8 字安全网
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: short, occurrences: [], draftRev: 2 }) })
  } finally {
    Date.now = realNow
  }
  assert.equal(bailCalls.length, 1, '短文本也必须折叠')
  assert.equal(bailCalls[0][2].span.end, '一条只有十几个字的短注释'.length)
})

check('用户自己打字不会被折叠（beforeinput 宽限期）', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }

  const realNow = Date.now
  let clock = 9_000_000
  Date.now = () => clock
  try {
    resetHooks({ clear: true })
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '', occurrences: [], draftRev: 1 }) })
    clock += 5000
    // 模拟敲键：beforeinput 先到
    listeners.get('beforeinput')?.()
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '手动打入的一段内容', occurrences: [], draftRev: 2 }) })
  } finally {
    Date.now = realNow
  }
  assert.equal(bailCalls.length, 0, '用户输入不能被折叠')
  const skip = __internals.pendingLogs().filter(entry => entry.ev === 'insertion.skip' && entry.data.reason === 'user-typing').at(-1)
  assert.ok(skip !== undefined, '应记录跳过的原因')
})

check('回归：胶囊标签本身不会被再折叠一次（否则发送时只发出标签）', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }
  const ctx = makePluginContext()
  ctx.sessions = { scope: () => actx }
  apply(ctx)

  const realNow = Date.now
  let clock = 13_000_000
  Date.now = () => clock
  try {
    // 1) 先渲染一次，让插件记住该会话的输入状态（append 需要它算插入点）
    resetHooks({ clear: true })
    renderHost({
      inputActions: actions, pasteChipActx: actx,
      useInput: selector => selector({ sessionId: 's1', draft: '', occurrences: [], draftRev: 1 }),
    })

    // 2) 粘贴路径：1k 字折叠成胶囊（标签被登记）
    clock += 5000
    const body = 'PR seafintec 的评审说明'.repeat(60)
    const result = ctx.pasteChip.append(body, { sessionId: 's1' })
    assert.equal(result.ok, true, 'append 应当成功')
    const label = result.label

    // 3) 系统把标签插进草稿：看起来就像「外部插入了一段文本」
    bailCalls.length = 0
    renderHost({
      inputActions: actions, pasteChipActx: actx,
      useInput: selector => selector({
        sessionId: 's1', draft: label,
        occurrences: [{ source: SOURCE, ref: result.ref, offset: 0, length: label.length }],
        draftRev: 2,
      }),
    })
  } finally {
    Date.now = realNow
  }

  assert.equal(bailCalls.length, 0, '标签本身不能再被折叠成新胶囊')
  const skip = __internals.pendingLogs().filter(entry => entry.ev === 'insertion.skip' && entry.data.reason === 'own-label').at(-1)
  assert.ok(skip !== undefined, '应记录 own-label 跳过原因')
})


check('预热窗口内的变化不接管（会话切换恢复草稿）', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }

  const realNow = Date.now
  let clock = 7_000_000
  Date.now = () => clock
  try {
    resetHooks({ clear: true })
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: '', occurrences: [], draftRev: 1 }) })
    clock += 200 // 仍在 1200ms 预热窗口内
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: 'z'.repeat(800), occurrences: [], draftRev: 2 }) })
  } finally {
    Date.now = realNow
  }
  assert.equal(bailCalls.length, 0, '恢复草稿不能被当成外部插入')
})

check('已有胶囊时：先把 clipboard 偏移换算成 detect 偏移再插', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }
  // 胶囊在 clipboard 里占 label.length 个字符，在 detect 里只占 1 个 → 差值 = length-1
  const label = '粘贴「abc」· 1 字'
  const occ = { source: SOURCE, ref: 'r1', offset: 0, length: label.length }
  const injected = 'x'.repeat(40)

  const realNow = Date.now
  let clock = 12_000_000
  Date.now = () => clock
  try {
    resetHooks({ clear: true })
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: label, occurrences: [occ], draftRev: 1 }) })
    clock += 5000
    renderHost({ inputActions: actions, pasteChipActx: actx, useInput: selector => selector({ draft: label + injected, occurrences: [occ], draftRev: 2 }) })
  } finally {
    Date.now = realNow
  }

  assert.equal(bailCalls.length, 1, '有既有胶囊也应该能插入，只是坐标要换算')
  const span = bailCalls[0][2].span
  assert.equal(span.start, 1, '胶囊之后在 detect 坐标里是 1')
  assert.equal(span.end, 1 + injected.length)
  assert.equal(span.draftRev, 2)
})

check('clipboardToDetect：多个胶囊逐段扣减，落在胶囊内部吸到其后', () => {
  const { clipboardToDetect } = __internals
  const occs = [
    { source: SOURCE, offset: 0, length: 5 },
    { source: SOURCE, offset: 5, length: 8 },
  ]
  // 纯文本区（两个胶囊之后）
  assert.equal(clipboardToDetect(13, occs), 2)      // 13 - (4+7)
  assert.equal(clipboardToDetect(20, occs), 9)      // 20 - 11
  // 边界：恰好在第一个胶囊末尾
  assert.equal(clipboardToDetect(5, occs), 1)
  // 落在第二个胶囊内部 → 吸到它之后（detect 2）
  assert.equal(clipboardToDetect(9, occs), 2)
  // 没有胶囊时原样返回
  assert.equal(clipboardToDetect(7, []), 7)
})



check('点击胶囊：openReference 能接管并打开常驻预览', () => {
  const sources = []
  const slots = []
  const ctx = makePluginContext({ sources, slots })
  apply(ctx)
  const source = sources.at(-1)
  assert.equal(typeof source.openReference, 'function', 'source 应实现 openReference')

  const body = '点击预览的正文'.repeat(60)
  const ref = writeBody(body)
  assert.equal(source.openReference({}, { ref, appearance: 'file' }), true, '命中正文应接管')
  const pinnedLog = __internals.pendingLogs().filter(entry => entry.ev === 'preview.pin').at(-1)
  assert.ok(pinnedLog !== undefined, '应记录 preview.pin')
  assert.equal(pinnedLog.data.chars, body.length)

  // 正文没了就别抢点击：返回 false，留给后续默认行为
  assert.equal(source.openReference({}, { ref: 'c-missing' }), false)
})

/* ------------------------------------------------------------------ *
 * 3.8 对外服务 pasteChip.insert（方案 C 的主动接法）
 * ------------------------------------------------------------------ */
/** 构造一个能跑 apply() 的假 ctx；provide 会把服务挂回 ctx 上，和 cordis 一致。 */
function makePluginContext({ sources = [], slots = [], sessionScope } = {}) {
  const ctx = {
    effect: fn => { fn() },
    inject: (_names, fn) => { fn() },
    provide: (name, value) => { ctx[name] = value },
    logger: { info: () => {} },
    inputTriggers: { registerSource: src => { sources.push(src); return () => {} } },
    sessions: { scope: sessionScope ?? (id => ({ id })) },
    slots: {
      inject: (_name, fn) => { fn() },
      register: (desc, component) => { slots.push({ desc, component }); return () => {} },
    },
  }
  return ctx
}

check('apply 会 expose ctx.pasteChip 服务', () => {
  const ctx = makePluginContext()
  apply(ctx)
  assert.ok(ctx.pasteChip !== undefined, '应注册 pasteChip 服务')
  assert.equal(typeof ctx.pasteChip.insert, 'function')
  assert.equal(ctx.pasteChip.version, __internals.VERSION)
})

check('主动 insert：给定 span 就精确插入并把正文存起来', () => {
  const bailCalls = []
  const ctx = makePluginContext()
  // 覆盖会话 actx：bail 记录调用
  ctx.sessions = { scope: () => ({ bail: (...args) => { bailCalls.push(args); return true } }) }
  apply(ctx)

  const body = '注释正文'.repeat(200)
  const result = ctx.pasteChip.insert(body, {
    sessionId: 'session-x',
    span: { start: 10, end: 10, draftRev: 42 },
  })

  assert.equal(result.ok, true)
  assert.equal(bailCalls.length, 1)
  const [, event, request] = bailCalls[0]
  assert.equal(event, 'slash/input-insert-reference')
  assert.equal(request.reference.source, SOURCE)
  assert.deepEqual(request.span, { start: 10, end: 10, draftRev: 42 })
  assert.equal(readBody(result.ref), body, '正文要能按返回的 ref 取回')
  assert.match(result.label, /粘贴「/)
})

check('主动 insert 支持自定义标签（例如「注释 · 3 条」）', () => {
  const ctx = makePluginContext()
  ctx.sessions = { scope: () => ({ bail: () => true }) }
  apply(ctx)
  const result = ctx.pasteChip.insert('x'.repeat(500), {
    sessionId: 's', span: { start: 0, end: 0, draftRev: 1 }, label: '注释 · 3 条',
  })
  assert.equal(result.ok, true)
  assert.equal(result.label, '注释 · 3 条')
})

check('主动 insert 的失败分支都说清原因，且不留孤儿正文', () => {
  const ctx = makePluginContext()
  let bailResult = false
  // 未知会话必须解析不到 actx（真实 sessions.scope 的行为）
  ctx.sessions = { scope: id => (id === 'nope' ? undefined : { bail: () => bailResult }) }
  apply(ctx)

  assert.deepEqual(ctx.pasteChip.insert('', { span: { start: 0, end: 0, draftRev: 1 } }), { ok: false, reason: 'empty' })
  assert.equal(ctx.pasteChip.insert('x'.repeat(DEFAULT_SETTINGS.maxChars + 1), { span: { start: 0, end: 0, draftRev: 1 } }).reason, 'too-long')
  assert.equal(ctx.pasteChip.insert('abc', {}).reason, 'span-required')
  assert.equal(ctx.pasteChip.insert('abc', { span: { start: 0, end: 0, draftRev: 1 }, sessionId: 'nope' }).reason, 'no-session')

  const refused = ctx.pasteChip.insert('y'.repeat(600), { sessionId: 's', span: { start: 0, end: 0, draftRev: 1 } })
  assert.equal(refused.reason, 'bail-refused')
})

check('append：不需要调用方给 span，按会话末尾插入', () => {
  const bailCalls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => {} }
  const actx = { bail: (...args) => { bailCalls.push(args); return true } }
  const ctx = makePluginContext()
  ctx.sessions = { scope: () => actx }
  apply(ctx)

  // 组件渲染时会记住该会话的输入状态（draft 长度 2 → 插入点 2）
  resetHooks({ clear: true })
  renderHost({
    inputActions: actions,
    pasteChipActx: actx,
    sessionId: 's1',
    useInput: selector => selector({ sessionId: 's1', draft: '你好', occurrences: [], draftRev: 7 }),
  })

  const body = '注释正文'.repeat(30)
  const result = ctx.pasteChip.append(body, { sessionId: 's1', label: '注释 · 1' })
  assert.equal(result.ok, true)
  assert.equal(result.label, '注释 · 1')
  const span = bailCalls.at(-1)[2].span
  assert.deepEqual(span, { start: 2, end: 2, draftRev: 7 })

  // 未知会话 → 明确拒绝
  assert.equal(ctx.pasteChip.append('x', { sessionId: 'nope' }).reason, 'no-input-state')
})

check('replace：原地换正文，ref 不变', () => {
  const ctx = makePluginContext()
  ctx.sessions = { scope: () => ({ bail: () => true }) }
  apply(ctx)

  const ref = writeBody('第一版正文')
  assert.equal(ctx.pasteChip.replace(ref, '第二版正文').ok, true)
  assert.equal(readBody(ref), '第二版正文', '同一 ref 下的正文应被替换')
  // 未知 ref / 空正文 / 超长 都要拒绝
  assert.equal(ctx.pasteChip.replace('c-missing', 'x').reason, 'unknown-ref')
  assert.equal(ctx.pasteChip.replace(ref, '').reason, 'empty')
  assert.equal(ctx.pasteChip.replace(ref, 'x'.repeat(DEFAULT_SETTINGS.maxChars + 1)).reason, 'too-long')
})

/* ------------------------------------------------------------------ *
 * 4. 日志：控制台 + 内存探针 + 批量落盘三条路
 * ------------------------------------------------------------------ */
check('apply 会记录 client.loaded / source.registered / slot.registered', () => {
  const sources = []
  const slots = []
  const ctx = makePluginContext({ sources, slots })
  apply(ctx)
  const events = __internals.pendingLogs().map(entry => entry.ev)
  assert.ok(events.includes('client.loaded'), `应有 client.loaded，实际 ${events.join(',')}`)
  assert.ok(events.includes('source.registered'), '应有 source.registered')
  assert.ok(events.includes('slot.registered'), '应有 slot.registered')
})

check('一次长粘贴产生 paste.seen 与 paste.outcome，并能批量上报', async () => {
  const actions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: () => {},
  }
  const actx = { bail: () => true }
  resetHooks({ clear: true })
  renderHost({ inputActions: actions, pasteChipActx: actx })
  const handler = listeners.get('paste')

  posted.length = 0
  handler({
    target: {},
    clipboardData: { getData: () => '文'.repeat(1500) },
    preventDefault: () => {},
    stopPropagation: () => {},
  })

  const events = __internals.pendingLogs().map(entry => entry.ev)
  assert.ok(events.includes('paste.seen'), `应有 paste.seen，实际 ${events.join(',')}`)
  assert.ok(events.includes('paste.outcome'), '应有 paste.outcome')

  __internals.flush()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(posted.length >= 1, 'flush 应把日志 POST 给宿主')
  assert.equal(posted[0].url, __internals.LOG_PATH)
  assert.ok(Array.isArray(posted[0].body.events) && posted[0].body.events.length > 0, '上报体应包含事件数组')
  const outcome = posted[0].body.events.find(entry => entry.ev === 'paste.outcome')
  assert.equal(outcome?.data?.outcome, 'chip')
})

check('serialize 命中与未命中都留痕', async () => {
  const sources = []
  const slots = []
  const ctx = {
    effect: fn => { fn() },
    inject: (_names, fn) => { fn() },
    inputTriggers: { registerSource: src => { sources.push(src); return () => {} } },
    sessions: { scope: id => ({ id }) },
    slots: { inject: (_n, fn) => { fn() }, register: () => () => {} },
  }
  apply(ctx)
  const source = sources.at(-1)
  const ref = writeBody('要展开的正文')
  const body = await source.codec.serialize(ref)
  assert.equal(body, '要展开的正文')
  const events = __internals.pendingLogs().map(entry => entry.ev)
  assert.ok(events.includes('codec.serialize'), 'serialize 应留痕')
  const hit = __internals.pendingLogs().filter(entry => entry.ev === 'codec.serialize' && entry.data.ref === ref).at(-1)
  assert.ok(hit !== undefined, '应当有针对这个 ref 的 serialize 记录')
  assert.equal(hit.data.hit, true)
})

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
check('第二层防线：正文若只是标签（嵌套遗留），宁可拦住发送', async () => {
  const sources = []
  const ctx = makePluginContext({ sources })
  apply(ctx)
  const source = sources.at(-1)

  // 造一个「正文=标签」的历史条目，模拟旧版本嵌套留下的胶囊
  const label = __internals.chipLabel('原来的一段长文本')
  const ref = writeBody(label)

  let rejected = null
  try {
    await source.codec.serialize(ref)
  } catch (error) {
    rejected = error
  }
  assert.ok(rejected !== null, '不能把标签当正文发出去')
  assert.match(rejected.message, /重新粘贴/, '要告诉用户怎么办')
})

/* ------------------------------------------------------------------ *
 * 5. 配置：默认值 / 夹取 / 从宿主读取
 * ------------------------------------------------------------------ */
check('默认配置齐全，且未读宿主前即为默认值', () => {
  const keys = Object.keys(DEFAULT_SETTINGS)
  assert.ok(keys.length >= 12, `应至少 12 个可调项，实际 ${keys.length}`)
  assert.equal(getSettings().collapseChars, 400)
  assert.equal(getSettings().collapseLines, 12)
  assert.equal(getSettings().previewChars, 320)
})

check('normalizeSettings：越界夹到边界，垃圾值忽略', () => {
  const merged = normalizeSettings({
    collapseChars: 5,          // 低于下限 100
    collapseLines: 9999,       // 高于上限 200
    maxChars: 1000000,
    previewChars: 'abc',       // 非数字 → 忽略
    hoverDelayMs: 200.7,       // 取整
    unknown: 42,               // 未知键 → 丢弃
  })
  assert.equal(merged.collapseChars, 100)
  assert.equal(merged.collapseLines, 200)
  assert.equal(merged.maxChars, 1000000)
  assert.equal(merged.previewChars, DEFAULT_SETTINGS.previewChars)
  assert.equal(merged.hoverDelayMs, 201)
  assert.equal('unknown' in merged, false)
  // 非对象输入也要安全
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
})

check('loadSettings：从宿主接口覆盖默认值，失败则保持默认', async () => {
  await __internals.loadSettings()
  assert.equal(getSettings().collapseChars, 1200, '应使用宿主返回的 1200')

  // 接口挂掉时不能把配置打回 0 或抛错
  const realFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('offline'))
  await __internals.loadSettings()
  globalThis.fetch = realFetch
  assert.equal(getSettings().collapseChars, 1200, '失败应保持上一次生效值')
})

await Promise.all(pendingChecks)
console.log(results.join('\n'))
const failed = results.filter(line => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
