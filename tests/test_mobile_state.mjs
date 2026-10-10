import test from 'node:test'
import assert from 'node:assert/strict'

import { initialState, reduceFrame, visibleStatus } from '../mobile/state.mjs'

test('task frames maintain a per-task approval queue and exact ids', () => {
  let state = initialState()
  state = reduceFrame(state, { type: 'task_started', id: 'a', prompt: 'first task' })
  state = reduceFrame(state, { type: 'task_started', id: 'b', prompt: 'second task' })
  state = reduceFrame(state, { type: 'task_needs_input', id: 'b', question: 'Allow command?' })

  assert.deepEqual(state.pending, ['a', 'b'])
  assert.deepEqual(state.approvals, [{ id: 'b', question: 'Allow command?', sending: false }])
  assert.equal(visibleStatus(state).label, 'Approval needed')

  state = reduceFrame(state, { type: 'task_update', id: 'b', action: 'approve' })
  assert.deepEqual(state.pending, ['a', 'b'])
  assert.deepEqual(state.approvals, [])

  state = reduceFrame(state, { type: 'task_done', id: 'b', state: 'completed' })
  assert.deepEqual(state.pending, ['a'])
})

test('voice frames distinguish user, thinking, and assistant motion states', () => {
  let state = reduceFrame(initialState(), { type: 'socket_open' })
  assert.equal(state.session, 'live')
  state = reduceFrame(state, { type: 'mic_level', level: 0.4, speaking: true })
  assert.equal(state.voice, 'user')
  assert.equal(state.level, 0.4)

  state = reduceFrame(state, { type: 'in_text', text: 'hello' })
  assert.equal(state.voice, 'thinking')

  state = reduceFrame(state, { type: 'audio', level: 0.7 })
  assert.equal(state.voice, 'assistant')
  assert.equal(state.level, 0.7)
})

test('visible status prioritizes work and mute without hiding approvals', () => {
  let state = { ...initialState(), session: 'live', voice: 'assistant', muted: true, pending: ['a'] }
  assert.equal(visibleStatus(state).label, 'Hermes is working')

  state = { ...state, approvals: [{ id: 'a', question: 'Allow?', sending: false }] }
  assert.equal(visibleStatus(state).label, 'Approval needed')
})
