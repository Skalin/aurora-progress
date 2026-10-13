export type TaskStatus = 'planned' | 'running' | 'done' | 'failed'

export type Task = {
  title: string
  status: TaskStatus
  agentId?: string
  model?: string
  startedAt?: number
  endedAt?: number
  stepDone?: number
  stepTotal?: number
  note?: string
}

export type Flow = {
  title: string
  total: number
  done: number
  tasks: Task[]
  startedAt: number
  endedAt?: number
  isFinished: boolean
  // Started by a subagent launch, not by the progress tool.
  isAuto: boolean
}

export type Clock = { frame: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'aurora-progress': { flow: Flow | null; clock: Clock; isCollapsed: boolean }
  }
}
