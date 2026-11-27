import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'

const source = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const segment = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const helpers = segment('function escapeHtml(', '// ── 设置：')

test('model notes, parameters and labels render as text without creating elements', () => {
  const { document } = parseHTML('<html><body>' + ['outPos', 'outNeg', 'outLen', 'outKv', 'outNotes'].map((id) => `<div id="${id}"></div>`).join('') + '</body></html>')
  const value = '<img src=x onerror="alert(1)">'
  const code = segment('function renderResult(', '// ── 动作')
  vm.runInNewContext(helpers + code + '\nrenderResult(result);', { document, $: (id) => document.getElementById(id), state: {}, result: { positive: 'prompt', notes: [value], params: { steps: value, cfg: value, sampler: value, size: value }, model: value, familyLabel: value } })
  assert.equal(document.querySelectorAll('img').length, 0)
  assert.equal(document.getElementById('outNotes').textContent, value)
  assert.match(document.getElementById('outKv').textContent, /<img src=x/)
})

test('rule-provided family labels are escaped in selectable buttons', () => {
  const { document } = parseHTML('<html><body><div id="fams"></div></body></html>')
  const code = segment('function renderFams(', 'function setTab(')
  vm.runInNewContext(helpers + code + '\nrenderFams();', { document, $: (id) => document.getElementById(id), state: { family: 'test', families: [{ id: 'test', label: '<img src=x>', kind: 'tag' }] } })
  assert.equal(document.querySelectorAll('img').length, 0)
  assert.match(document.getElementById('fams').textContent, /<img src=x>/)
})

test('composition selection is submitted for generation and refinement', async () => {
  const { document } = parseHTML(source)
  document.querySelector('#composition option[value="diagonal"]').selected = true
  document.querySelector('#reasoningEffort option[value="high"]').selected = true
  const requests = []
  const state = { family: 'anima', cabinetIds: ['second', 'first'], cabinetModes: new Map() }
  const cabinetItems = [{ id: 'first', name: 'Ink', text: 'ink', mode: 'prefix' }, { id: 'second', name: 'Grain', text: 'grain', mode: 'blend' }]
  const context = { document, $: (id) => document.getElementById(id), state, cabinetItems, busy() {}, renderResult() {}, setStatus() {},
    post: async (path, payload) => { requests.push({ path, payload }); return { positive: 'test', notes: [] } } }
  const code = segment('function cabinetSelection(', 'function editCabinet(') + segment('async function run(', "$('runGen').onclick")
  vm.runInNewContext(code + '\nrenderCabinet();', context)
  const buttons = document.querySelectorAll('.cabinet-mode button')
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true')
  buttons[0].click()
  buttons[3].click()
  await vm.runInNewContext(code + '\nrun("gen");', context)
  await vm.runInNewContext(code + '\nrun("refine");', context)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].payload.composition, 'diagonal')
  assert.equal(requests[1].payload.composition, 'diagonal')
  assert.ok(requests.every(r => r.payload.reasoningEffort === 'high'))
  assert.ok(requests.every(r => JSON.stringify(r.payload.cabinetSelection) === JSON.stringify([{ id: 'second', mode: 'prefix' }, { id: 'first', mode: 'blend' }])))
  assert.equal(requests.every(r => r.path === '/compose'), true)
})

test('generation displays a pending indicator and restores the button on success and failure', async () => {
  const { document } = parseHTML(source)
  const $ = id => document.getElementById(id)
  const state = { family: 'generic' }
  let resolve, reject, tick, elapsed = 0
  const context = vm.createContext({ $, document, state, performance: { now: () => elapsed },
    setInterval(fn) { tick = fn; return 1 }, clearInterval() { tick = null }, renderResult() {},
    cabinetSelection: () => [], escapeHtml: s => s, post: () => new Promise((yes, no) => { resolve = yes; reject = no }) })
  vm.runInContext(segment('function setStatus(', 'function copy(') + segment('async function run(', "$('runGen').onclick"), context)
  for (const fails of [false, true]) {
    const pending = vm.runInContext('run("gen")', context)
    assert.equal($('runGen').disabled, true)
    assert.match($('runGen').textContent, /正在生成/)
    assert.equal($('taskProgress').classList.contains('hidden'), false)
    elapsed += 2000; tick()
    assert.equal($('taskElapsed').textContent, '2 秒')
    if (fails) reject(new Error('provider unavailable'))
    else resolve({ positive: 'prompt' })
    await pending
    assert.equal(tick, null)
    assert.equal($('runGen').disabled, false)
    assert.equal($('runGen').textContent, '生成提示词')
    assert.equal($('taskProgress').classList.contains('hidden'), true)
    assert.equal($('status').textContent, fails ? '失败' : '完成')
  }
})

test('composition controls are disabled for faithful reverse and local iteration', () => {
  const { document } = parseHTML(source)
  const context = { document, $: (id) => document.getElementById(id), state: {}, rulesData: null, loadRules() {}, loadSettings() {} }
  const code = segment('function setTab(', "\ndocument.querySelectorAll('.tab').forEach")
  vm.runInNewContext(code + '\nsetTab("reverse");', context)
  assert.equal(document.getElementById('composition').disabled, true)
  vm.runInNewContext(code + '\nsetTab("iterate");', context)
  assert.equal(document.getElementById('composition').disabled, true)
  vm.runInNewContext(code + '\nsetTab("gen");', context)
  assert.equal(document.getElementById('composition').disabled, false)
})
