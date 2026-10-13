import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never } as const

async function session($: Engine, on: On) {
  mock.clock(on, { now: Date.parse('2026-10-13T10:00:00Z') })
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('tool.register', async () => ({ value: {} }) as never)
  on('command.register', async () => ({ value: {} }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

async function texts($: Engine, pattern: RegExp): Promise<number> {
  const ui = await $.ui.mount({ plugin: 'aurora-progress', surface: 'terminal', ...BAND })
  const found = await ui.findAll({ type: 'Text', text: pattern })
  await ui.unmount()
  return found.length
}

test('the progress tool draws the title, count and each task row', async ($, on) => {
  await session($, on)
  await $.tool.call({ tool: 'mcp__aurora-progress__progress', title: 'Ship it', tasks: ['Build', 'Test', 'Deploy'], done: 1 } as never)
  expect(await texts($, /Ship it/)).toBeGreaterThan(0)
  expect(await texts($, /^1\/3$/)).toBe(1)
  expect(await texts($, /^Deploy/)).toBe(1)
})

test('finished shows 100%', async ($, on) => {
  await session($, on)
  await $.tool.call({ tool: 'mcp__aurora-progress__progress', title: 'Ship it', total: 2, done: 2, finished: true } as never)
  expect(await texts($, /^ · 100% · /)).toBe(1)
})
