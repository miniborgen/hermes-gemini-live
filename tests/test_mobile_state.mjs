import test from 'node:test'
import assert from 'node:assert/strict'

import { feedbackCue, hasScheduledPlayback, initialState, isCurrentConnection, laneVisualToken, reconnectDelay, reduceFrame, shouldTransmitMic, visibleStatus } from '../mobile/state.mjs'

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

test('lane selection is retained in idle state and reported when the relay opens', () => {
  let state = { ...initialState(), session: 'idle', selectedLane: 'garage-r129', laneName: 'Garage — R129' }
  state = reduceFrame(state, { type: 'lane_selected', id: 'garage-r129', name: 'Garage — R129' })
  assert.equal(state.selectedLane, 'garage-r129')
  assert.equal(state.laneName, 'Garage — R129')

  state = reduceFrame(state, { type: 'lane_context', id: 'garage-r129', name: 'Garage — R129' })
  assert.equal(state.activeLane, 'garage-r129')
  assert.equal(state.laneName, 'Garage — R129')
  assert.equal(visibleStatus(state).detail, 'Start when you are ready')
})

test('lane visuals are stable and remain inside the restrained warm palette', () => {
  assert.deepEqual(laneVisualToken('garage-r129'), laneVisualToken('garage-r129'))
  const token = laneVisualToken('personal-context')
  assert.ok(token.hue >= 14 && token.hue <= 47)
  assert.ok(token.motion >= 0.92 && token.motion <= 1.08)
})

test('reconnect state is explicit and retry delay is bounded', () => {
  assert.deepEqual([1, 2, 3, 4].map(reconnectDelay), [500, 1000, 2000, 2000])
  const state = reduceFrame(
    { ...initialState(), session: 'live', pending: ['old'], approvals: [{ id: 'old' }], captions: [{ speaker: 'user', text: 'old' }] },
    { type: 'reconnecting', attempt: 2 }
  )
  assert.equal(state.session, 'reconnecting')
  assert.deepEqual(state.pending, [])
  assert.deepEqual(state.approvals, [])
  assert.deepEqual(state.captions, [])
  assert.equal(visibleStatus(state).label, 'Reconnecting')
  assert.match(visibleStatus(state).detail, /fresh voice session/)
})

test('stable playback gating follows scheduled buffers rather than analyser residue', () => {
  assert.equal(hasScheduledPlayback({ liveCount: 1, scheduledUntil: 12, currentTime: 11.5 }), true)
  assert.equal(hasScheduledPlayback({ liveCount: 1, scheduledUntil: 12, currentTime: 12.1 }), false)
  assert.equal(hasScheduledPlayback({ liveCount: 0, scheduledUntil: 12, currentTime: 11.5 }), false)
})

test('stale socket callbacks cannot act on a replacement connection', () => {
  const oldSocket = {}
  const newSocket = {}
  assert.equal(isCurrentConnection(oldSocket, oldSocket), true)
  assert.equal(isCurrentConnection(newSocket, oldSocket), false)
  assert.equal(isCurrentConnection(null, oldSocket), false)
})

test('feedback cues stay brief and sound preference is explicit', () => {
  assert.deepEqual(feedbackCue('approval').vibration, [18, 35, 18])
  assert.ok(feedbackCue('connected').duration <= 0.06)
  const enabled = reduceFrame(initialState(), { type: 'sound_cues', enabled: true })
  assert.equal(enabled.soundCues, true)
})

test('duplex modes make speakerphone stability deterministic', () => {
  assert.equal(shouldTransmitMic({ mode: 'stable', assistantSpeaking: true }), false)
  assert.equal(shouldTransmitMic({ mode: 'stable', assistantSpeaking: false }), true)
  assert.equal(shouldTransmitMic({ mode: 'natural', assistantSpeaking: true }), true)
  assert.equal(shouldTransmitMic({ mode: 'stable', assistantSpeaking: true, interrupting: true }), true)

  const natural = reduceFrame(initialState(), { type: 'duplex_mode', mode: 'natural' })
  assert.equal(natural.duplexMode, 'natural')
})

test('streaming transcripts keep two ephemeral speaker-labelled caption lines', () => {
  let state = { ...initialState(), session: 'live', captionsEnabled: true }
  state = reduceFrame(state, { type: 'in_text', text: 'I am checking', at: 1000 })
  state = reduceFrame(state, { type: 'in_text', text: 'the garage', at: 1200 })
  state = reduceFrame(state, { type: 'out_text', text: 'The next task', at: 2000 })

  assert.deepEqual(state.captions, [
    { speaker: 'user', text: 'I am checking the garage', updatedAt: 1200 },
    { speaker: 'assistant', text: 'The next task', updatedAt: 2000 }
  ])

  state = reduceFrame(state, { type: 'out_text', text: 'The next task is the harness.', at: 2200 })
  assert.equal(state.captions.length, 2)
  assert.deepEqual(state.captions[1], {
    speaker: 'assistant', text: 'The next task is the harness.', updatedAt: 2200
  })

  state = reduceFrame(state, { type: 'caption_clear' })
  assert.deepEqual(state.captions, [])
})
