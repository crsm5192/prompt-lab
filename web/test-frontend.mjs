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
  const requests = []
  const context = { document, $: (id) => document.getElementById(id), state: { family: 'anima' }, busy() {}, renderResult() {}, setStatus() {},
    post: async (path, payload) => { requests.push({ path, payload }); return { positive: 'test', notes: [] } } }
  const code = segment('async function run(', "$('runGen').onclick")
  await vm.runInNewContext(code + '\nrun("gen");', context)
  await vm.runInNewContext(code + '\nrun("refine");', context)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].payload.composition, 'diagonal')
  assert.equal(requests[1].payload.composition, 'diagonal')
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
