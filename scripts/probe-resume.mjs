/**
 * 探针：resume（dispose 后同 id 重建）时，pre-step 补刀与技能影子是否还工作。
 * 假设：`agent/disposed` 把 id 永久放进 settled，resume 后 pre-step 直接 next()，
 * 于是恢复的会话完全不被掩码。
 */
import { apply } from '../lib/index.js'

const registry = { names: ['weather'] }
const mkTools = () => {
  const tools = {
    accepted: [],
    restrict(filter) {
      const unknown = filter.deny.filter((n) => !registry.names.includes(n))
      if (unknown.length > 0) throw new Error(`unknown global tool "${unknown[0]}"`)
      tools.accepted.push(...filter.deny)
      return () => {}
    },
    schemas: () => registry.names.map((name) => ({ name })),
  }
  return tools
}
const mkSkills = (shadowed) => ({
  list: async () => [{ name: 'summarize', description: '', provider: 'filesystem', source: 'bundled' }],
  registerProvider: (create) => {
    const provider = create({
      invalidate: () => {
        shadowed.length = 0
        for (const candidate of provider.list()) shadowed.push(candidate.name)
      },
    })
    return () => {}
  },
})

const handlers = new Map()
const tools = mkTools()
const shadowed = []
const skills = mkSkills(shadowed)
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  on: (event, cb) => handlers.set(event, cb),
  get: (key) => (key === 'agentPresets' ? { composedPreset: () => 'cherry' } : key === 'skills' ? skills : undefined),
  effect: (fn) => { fn(); return () => {} },
}
const agent = {
  id: 'resumed',
  ctx: { get: (key) => (key === 'tools' ? tools : key === 'skills' ? skills : undefined) },
  session: { header: { agentPreset: 'cherry', cwd: '/tmp/x' } },
}
const config = {
  audit: false,
  presets: { cherry: { tools: { deny: ['weather', 'late_tool'] }, skills: { denyNames: ['summarize'] } } },
}

apply(ctx, config)

const step = async () => handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }))

await handlers.get('agent/created')({ agent })
console.log('1) created 后 accepted =', JSON.stringify(tools.accepted), '| shadowed =', JSON.stringify(shadowed))

// late_tool 现在才注册
registry.names.push('late_tool')
tools.accepted = []
await step()
console.log('2) pre-step#1 accepted =', JSON.stringify(tools.accepted), '| shadowed =', JSON.stringify(shadowed))

await handlers.get('agent/disposed')({ agent })

// resume：同 id 的新 fiber，seal Map 已被清空，但 settled 里有这个 id
tools.accepted = []
shadowed.length = 0
await handlers.get('agent/created')({ agent })
console.log('3) resume created accepted =', JSON.stringify(tools.accepted), '| shadowed =', JSON.stringify(shadowed))

tools.accepted = []
await step()
console.log('4) resume pre-step accepted =', JSON.stringify(tools.accepted), '| shadowed =', JSON.stringify(shadowed))
// After resume, created() masks every registered name, so the pre-step pass has
// nothing NEW to mask — the contract it must still fulfil is the skill shadow.
const ok = shadowed.includes('summarize')
console.log(ok ? 'RESULT: resume 会话影子正常' : 'RESULT: 缺陷确认 —— resume 的会话技能影子从未建立')
process.exitCode = ok ? 0 : 1
