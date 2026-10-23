import test from 'node:test'
import assert from 'node:assert/strict'

import { conversationHighlight, feedbackCue, hasScheduledPlayback, initialState, isCurrentConnection, laneVisualToken, naturalSpeechGate, nextDisplayMode, radialTaskCards, reconnectDelay, reduceFrame, shouldConnectAfterLaneSwitch, shouldTransmitMic, taskCards, taskTitle, visibleStatus, workingLine } from '../mobile/state.mjs'

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

test('task snapshots restore actionable approvals for parked tasks', () => {
  const state = reduceFrame(initialState(), {
    type: 'task_snapshot',
    tasks: [{
      id: 'parked-1', title: 'Review proposed action', state: 'needs_input',
      startedAt: 1000, updatedAt: 2000, laneId: 'personal-assistant',
      laneName: 'Personal Assistant', question: 'Approve the proposed action?', preview: ''
    }]
  })
  assert.deepEqual(state.pending, ['parked-1'])
  assert.deepEqual(state.approvals, [{
    id: 'parked-1', question: 'Approve the proposed action?', sending: false
  }])
})

test('ready frames put session status in the unified status block', () => {
  const state = reduceFrame(initialState(), { type: 'ready', statusText: 'Conversation resumed' })
  assert.equal(state.session, 'live')
  assert.equal(state.detail, 'Conversation resumed')
  assert.equal(visibleStatus(state).detail, 'Conversation resumed')
})

test('structured tasks keep safe names timestamps lane and terminal previews', () => {
  let state = { ...initialState(), activeLane: 'garage-r129', laneName: 'Garage — R129' }
  state = reduceFrame(state, { type: 'task_started', id: 'a', prompt: 'Check https://private.example and /Users/me/file', at: 1000 })
  assert.equal(state.tasks[0].title, 'Check private link and private path')
  assert.deepEqual(state.tasks[0], {
    id: 'a', title: 'Check private link and private path', state: 'working', startedAt: 1000,
    updatedAt: 1000, laneId: 'garage-r129', laneName: 'Garage — R129', question: '', preview: ''
  })
  state = reduceFrame(state, { type: 'task_failed', id: 'a', detail: 'Failed at /Users/me/file', preview: 'Could not read /Users/me/file', at: 4000 })
  assert.equal(state.tasks[0].state, 'failed')
  assert.equal(state.tasks[0].preview, 'Could not read private path')
  assert.deepEqual(state.pending, [])
})

test('task cards show three tasks then an expandable remainder and elapsed active time', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    id: String(index), title: `Task ${index}`, state: index === 0 ? 'completed' : 'working',
    startedAt: index * 1000, updatedAt: index * 1000, laneId: '', laneName: '', question: '', preview: ''
  }))
  assert.deepEqual(taskCards(tasks, { now: 10000, expanded: false }).map(item => item.title), ['Task 4', 'Task 3'])
  assert.equal(taskCards(tasks, { now: 10000, expanded: false }).more, 3)
  assert.equal(taskCards(tasks, { now: 10000, expanded: true }).length, 5)
  assert.equal(taskCards(tasks, { now: 10000, expanded: true })[0].elapsedSeconds, 6)
})

test('radial task labels select active work before overflow and stay short', () => {
  const tasks = [
    { id: 'done-2', title: 'A recent completed task', state: 'completed', startedAt: 9000, updatedAt: 10000 },
    { id: 'done-1', title: 'Another recent completed task', state: 'completed', startedAt: 8000, updatedAt: 9000 },
    { id: 'active-1', title: 'Schedule an event on the calendar tonight at 8:30 PM for the family', state: 'working', startedAt: 1000, updatedAt: 2000 },
    { id: 'active-2', title: 'Check Magnus calendar history for the usual evening routine', state: 'needs_input', startedAt: 1000, updatedAt: 1500 }
  ]
  const radial = radialTaskCards(tasks, { now: 11000 })
  assert.deepEqual(radial.map(task => task.id), ['active-1', 'active-2', 'done-2'])
  assert.equal(radial[0].shortTitle, 'Schedule calendar event')
  assert.equal(radial[1].shortTitle, 'Check calendar history')
  assert.equal(radial[0].elapsedSeconds, 10)
  assert.ok(radial.every(task => task.orbSize >= 7 && task.orbSize <= 13))
  assert.ok(radial.every(task => task.driftSeconds >= 18 && task.driftSeconds <= 30))
  assert.equal(radial[0].orbSize, radialTaskCards(tasks, { now: 12000 })[0].orbSize)
})

test('radial task labels retain recent terminal outcomes after active work', () => {
  const tasks = [
    { id: 'active', title: 'Check calendar history', state: 'working', startedAt: 1000, updatedAt: 5000 },
    { id: 'done', title: 'Submit signed Sunnyside form', state: 'completed', startedAt: 1000, updatedAt: 6000, preview: 'Submitted successfully' },
    { id: 'failed', title: 'Fetch archived invoice', state: 'failed', startedAt: 1000, updatedAt: 4000, preview: 'No invoice found' }
  ]
  const radial = radialTaskCards(tasks, { now: 7000 })
  assert.deepEqual(radial.map(task => task.id), ['active', 'done', 'failed'])
  assert.equal(radial[1].state, 'completed')
  assert.equal(radial[1].shortTitle, 'Submit signed Sunnyside form')
})

test('task title removes transcripts credentials emails urls and paths', () => {
  assert.equal(taskTitle('Please email me@example.com token=secret https://example.com /Users/me/a'), 'Please email private email private value private link private path')
})

test('mic mute and output mute are independent', () => {
  let state = reduceFrame(initialState(), { type: 'mic_mute', muted: true })
  assert.equal(state.micMuted, true)
  assert.equal(state.outputMuted, false)
  state = reduceFrame(state, { type: 'output_mute', muted: true })
  assert.equal(state.micMuted, true)
  assert.equal(state.outputMuted, true)
  assert.equal(state.captionsEnabled, true)
  assert.equal(shouldTransmitMic({ mode: 'natural', assistantSpeaking: false, micMuted: true }), false)
  assert.equal(shouldTransmitMic({ mode: 'stable', assistantSpeaking: true, micMuted: false, interrupting: false }), false)
  assert.equal(shouldTransmitMic({ mode: 'stable', assistantSpeaking: true, micMuted: false, interrupting: true }), true)
})

test('natural barge-in requires sustained onset and hysteresis while playback is active', () => {
  let gate = { active: false, onsetAt: 0, lastAboveAt: 0, noiseFloor: 0.012 }
  let result = naturalSpeechGate(gate, { peak: 0.04, now: 1000, assistantSpeaking: true })
  assert.equal(result.speaking, false)
  result = naturalSpeechGate(result.gate, { peak: 0.04, now: 1070, assistantSpeaking: true })
  assert.equal(result.speaking, false)
  result = naturalSpeechGate(result.gate, { peak: 0.04, now: 1140, assistantSpeaking: true })
  assert.equal(result.speaking, true)
  result = naturalSpeechGate(result.gate, { peak: 0.018, now: 1300, assistantSpeaking: true })
  assert.equal(result.speaking, true)
  result = naturalSpeechGate(result.gate, { peak: 0.008, now: 1720, assistantSpeaking: true })
  assert.equal(result.speaking, false)
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
  assert.equal(visibleStatus(state).detail, 'Working on 1 task for you')

  state = { ...state, pending: ['a', 'b', 'c', 'd'] }
  assert.equal(visibleStatus(state).detail, 'Working on 4 tasks for you')

  state = { ...state, approvals: [{ id: 'a', question: 'Allow?', sending: false }] }
  assert.equal(visibleStatus(state).label, 'Approval needed')
})

test('muting voice output enables captions and unmuting keeps them available', () => {
  let state = { ...initialState(), session: 'live', captionsEnabled: false }
  state = reduceFrame(state, { type: 'mute', muted: true })
  assert.equal(state.muted, true)
  assert.equal(state.captionsEnabled, true)
  assert.equal(state.outputGain, 0)

  state = reduceFrame(state, { type: 'mute', muted: false })
  assert.equal(state.muted, false)
  assert.equal(state.captionsEnabled, true)
  assert.equal(state.outputGain, 1)
})

test('working copy rotates through a varied playful set', () => {
  const lines = new Set(Array.from({ length: 20 }, (_, index) => workingLine(index)))
  assert.equal(lines.size, 20)
  assert.equal([...lines].some(line => /^Mini is /i.test(line)), false)
  assert.match(workingLine(19), /discombobulating/i)
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

test('general conversation needs no lane and switching lanes clears old-session state', () => {
  const general = { ...initialState(), session: 'idle', selectedLane: '', laneName: 'One-off chat' }
  assert.equal(visibleStatus(general).detail, 'Start a one-off conversation')

  const switched = reduceFrame({
    ...general,
    session: 'live',
    selectedLane: 'garage-r129',
    laneName: 'Garage — R129',
    activeLane: 'garage-r129',
    pending: ['old-task'],
    approvals: [{ id: 'old-task' }],
    captions: [{ speaker: 'assistant', text: 'old words' }]
  }, { type: 'lane_switching', id: '', name: 'One-off chat' })

  assert.equal(switched.session, 'starting')
  assert.equal(switched.selectedLane, '')
  assert.equal(switched.laneName, 'One-off chat')
  assert.equal(switched.activeLane, null)
  assert.deepEqual(switched.pending, [])
  assert.deepEqual(switched.approvals, [])
  assert.deepEqual(switched.captions, [])
})

test('lane switching during microphone startup does not create a duplicate relay', () => {
  assert.equal(shouldConnectAfterLaneSwitch({ hasSocket: false, captureReady: false }), false)
  assert.equal(shouldConnectAfterLaneSwitch({ hasSocket: true, captureReady: false }), true)
  assert.equal(shouldConnectAfterLaneSwitch({ hasSocket: false, captureReady: true }), true)
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

test('stable mode never marks playback feedback as user speech', () => {
  assert.equal(shouldTransmitMic({ mode: 'stable', assistantSpeaking: true, interrupting: false }), false)
  assert.equal(shouldTransmitMic({ mode: 'stable', assistantSpeaking: true, interrupting: true }), true)
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
  const disabled = reduceFrame(enabled, { type: 'sound_cues', enabled: false })
  assert.equal(disabled.soundCues, false)
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
  state = reduceFrame(state, { type: 'in_text', text: ' the garage', at: 1200 })
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

  state = reduceFrame(state, { type: 'out_text', text: ', then test it.', at: 2300 })
  assert.equal(state.captions[1].text, 'The next task is the harness, then test it.')

  state = reduceFrame(state, { type: 'caption_clear' })
  assert.deepEqual(state.captions, [])
})

test('stream mode keeps a deduplicated rolling word trail for both speakers', () => {
  let state = reduceFrame(initialState(), { type: 'display_mode', mode: 'stream' })
  state = reduceFrame(state, { type: 'in_text', text: 'I am checking', at: 1000 })
  state = reduceFrame(state, { type: 'in_text', text: 'I am checking the garage now', at: 1200 })

  assert.equal(state.displayMode, 'stream')
  assert.deepEqual(state.streamWords.map(item => item.text), ['I', 'am', 'checking', 'the', 'garage', 'now'])
  assert.equal(state.streamWords.at(-1).speaker, 'user')

  state = reduceFrame(state, { type: 'out_text', text: 'The next task is ready', at: 2000 })
  assert.deepEqual(state.streamWords.slice(-5).map(item => item.text), ['The', 'next', 'task', 'is', 'ready'])
  assert.equal(state.streamWords.at(-1).speaker, 'assistant')
  assert.deepEqual(state.streamWordsBySpeaker.user.map(item => item.text), ['I', 'am', 'checking', 'the', 'garage', 'now'])
  assert.deepEqual(state.streamWordsBySpeaker.assistant.map(item => item.text), ['The', 'next', 'task', 'is', 'ready'])
})

test('stream mode treats arriving text as visual word material', () => {
  let state = reduceFrame(initialState(), { type: 'display_mode', mode: 'stream' })
  state = reduceFrame(state, { type: 'out_text', text: 'I can', at: 1000 })
  state = reduceFrame(state, { type: 'out_text', text: ' help', at: 1100 })
  state = reduceFrame(state, { type: 'out_text', text: ' you', at: 1200 })
  assert.deepEqual(state.streamWordsBySpeaker.assistant.map(item => item.text), ['I', 'can', 'help', 'you'])

  state = reduceFrame(state, { type: 'out_text', text: 'I can help you now', at: 1300 })
  assert.deepEqual(state.streamWordsBySpeaker.assistant.map(item => item.text), ['I', 'can', 'help', 'you', 'now'])

  state = reduceFrame(state, { type: 'out_text', text: 'heal', at: 1400 })
  assert.deepEqual(state.streamWordsBySpeaker.assistant.map(item => item.text), ['I', 'can', 'help', 'you', 'now', 'heal'])
})

test('stream mode never stalls while cumulative text revises earlier words', () => {
  let state = reduceFrame(initialState(), { type: 'display_mode', mode: 'stream' })
  state = reduceFrame(state, { type: 'out_text', text: 'the cat and the dog', at: 1000 })
  state = reduceFrame(state, { type: 'out_text', text: 'the cat or the dog', at: 1200 })
  assert.deepEqual(state.streamWordsBySpeaker.assistant.map(item => item.text), ['the', 'cat', 'and', 'the', 'dog', 'or', 'the', 'dog'])

  state = reduceFrame(state, { type: 'out_text', text: 'the cat', at: 1400 })
  assert.deepEqual(state.streamWordsBySpeaker.assistant.map(item => item.text), ['cat', 'and', 'the', 'dog', 'or', 'the', 'dog', 'the', 'cat'])
  assert.equal(state.streamSources.assistant, 'the cat')

  state = reduceFrame(state, { type: 'out_text', text: 'the answer', at: 4000 })
  assert.deepEqual(state.streamWordsBySpeaker.assistant.map(item => item.text), ['the', 'answer'])
})

test('stream mode retains only nine words and clears them at privacy boundaries', () => {
  let state = reduceFrame(initialState(), { type: 'display_mode', mode: 'stream' })
  state = reduceFrame(state, { type: 'in_text', text: 'one two three four five six seven eight nine ten eleven', at: 1000 })
  assert.deepEqual(state.streamWordsBySpeaker.user.map(item => item.text), ['three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'])

  state = reduceFrame(state, { type: 'reconnecting', attempt: 1 })
  assert.deepEqual(state.streamWords, [])
  assert.deepEqual(state.streamWordsBySpeaker, { user: [], assistant: [] })
  assert.deepEqual(state.streamSources, { user: '', assistant: '' })
  assert.equal(state.streamComplete, false)
})

test('completed turns mark Stream words to leave after speech stops', () => {
  let state = reduceFrame(initialState(), { type: 'display_mode', mode: 'stream' })
  state = reduceFrame(state, { type: 'out_text', text: 'The task is ready', at: 1000 })
  assert.equal(state.streamComplete, false)

  state = reduceFrame(state, { type: 'turn_complete' })
  assert.equal(state.streamComplete, true)

  state = reduceFrame(state, { type: 'in_text', text: 'What changed', at: 2000 })
  assert.equal(state.streamComplete, false)
})

test('Stream completion state clears at every session privacy boundary', () => {
  const completed = {
    ...initialState(),
    streamWords: [{ text: 'done', speaker: 'assistant', updatedAt: 1 }],
    streamComplete: true
  }
  for (const frame of [
    { type: 'lane_switching', id: '', name: 'One-off chat' },
    { type: 'go_away' },
    { type: 'error', detail: 'closed' }
  ]) {
    const next = reduceFrame(completed, frame)
    assert.deepEqual(next.streamWords, [])
    assert.equal(next.streamComplete, false)
  }
})

test('display mode cycles orb to flow to stream and back to orb', () => {
  assert.equal(nextDisplayMode('orb'), 'text')
  assert.equal(nextDisplayMode('text'), 'stream')
  assert.equal(nextDisplayMode('stream'), 'orb')
  assert.equal(nextDisplayMode('unknown'), 'orb')
})

test('text mode distills live speech into a bottom-up ephemeral highlight stack', () => {
  assert.equal(
    conversationHighlight('Um, I think we should just check the oil pressure sensor wiring next.'),
    'Check the oil pressure sensor wiring next.'
  )

  let state = reduceFrame(initialState(), { type: 'display_mode', mode: 'text' })
  state = reduceFrame(state, {
    type: 'in_text',
    text: 'I think we should just check the oil pressure sensor wiring next.',
    at: 1000
  })
  state = reduceFrame(state, {
    type: 'out_text',
    text: 'I will compare the connector pinout and order the replacement.',
    at: 3000
  })

  assert.equal(state.displayMode, 'text')
  assert.deepEqual(state.highlights, [])
  state = reduceFrame(state, { type: 'turn_complete' })
  assert.deepEqual(state.highlights.map(item => item.text), [
    'Check the oil pressure sensor wiring next.'
  ])
  assert.equal(state.highlights[0].speaker, 'exchange')
  assert.deepEqual(state.highlightWindow, [])

  state = reduceFrame(state, { type: 'reconnecting', attempt: 1 })
  assert.deepEqual(state.highlights, [])
})

test('conversation highlights summarize common inquiries instead of repeating the transcript', () => {
  assert.equal(
    conversationHighlight('What kind of context do you get when I start this chat?'),
    'Context available when starting a chat'
  )
  assert.equal(
    conversationHighlight('Can you tell me what happened with the VC integration and where it stands now?'),
    'VC integration status'
  )
  assert.equal(
    conversationHighlight('What context do you have on my car?'),
    'Known vehicle context'
  )
  assert.equal(
    conversationHighlight('I am looking into the records for your tires.'),
    'Tire records lookup'
  )
  assert.equal(
    conversationHighlight('The driver-door body-side striker was adjusted downward on September 29th.'),
    'Driver-door striker adjustment'
  )
  assert.equal(
    conversationHighlight('What was that about meeting up with August? I am checking your recent messages for mentioned meetups with August. You planned to meet Emy and August at Glen Park for pizza.'),
    'Kids’ pizza playdate in Glen Park'
  )
  assert.equal(
    conversationHighlight('I hate a things from a teacher. I am looking into Mila’s math activity. It appears there is no math activity from Mila’s teacher.'),
    'No recent math activity from Mila’s teacher'
  )
})

test('highlights wait for a completed longer exchange and preserve word boundaries', () => {
  let state = reduceFrame(initialState(), {
    type: 'in_text',
    text: 'We need',
    at: 1000
  })
  state = reduceFrame(state, {
    type: 'in_text',
    text: ' to make the shoulder routine feel more comfortable and human.',
    at: 1100
  })

  state = reduceFrame(state, { type: 'speech_started' })
  assert.deepEqual(state.highlights, [])
  assert.match(state.highlightWindow[0].source, /need to make/)

  state = reduceFrame(state, { type: 'turn_complete' })
  assert.deepEqual(state.highlights.map(item => item.text), [
    'Make the shoulder routine feel more comfortable and human.'
  ])

  let short = reduceFrame(initialState(), { type: 'in_text', text: 'yes', at: 2000 })
  short = reduceFrame(short, { type: 'turn_complete' })
  assert.deepEqual(short.highlights, [])
})

test('single-speaker highlights retain speaker identity', () => {
  let state = reduceFrame(initialState(), {
    type: 'out_text',
    text: 'I will inspect the wiring harness and report the exact connector next.',
    at: 1000
  })
  state = reduceFrame(state, { type: 'turn_complete' })
  assert.equal(state.highlights[0].speaker, 'assistant')
})

test('live listening status does not duplicate the selected lane and interruption copy is display neutral', () => {
  const listening = { ...initialState(), session: 'live', laneName: 'PT + Movement' }
  assert.deepEqual(visibleStatus(listening), { label: 'Listening', detail: '' })

  const speaking = { ...listening, voice: 'assistant', duplexMode: 'stable', displayMode: 'text' }
  assert.deepEqual(visibleStatus(speaking), { label: 'Speaking', detail: 'Tap to interrupt' })
})

test('terminal voice states clear distilled and raw highlight content', () => {
  const highlighted = reduceFrame(
    { ...initialState(), session: 'live', pending: ['private-task'], approvals: [{ id: 'private-task', question: 'Private approval?' }] },
    { type: 'in_text', text: 'private raw spoken details', at: 1000 }
  )
  assert.equal(highlighted.highlightWindow[0].source, 'private raw spoken details')

  for (const frame of [
    { type: 'go_away' },
    { type: 'error', detail: 'closed' }
  ]) {
    const terminal = reduceFrame(highlighted, frame)
    assert.deepEqual(terminal.highlights, [])
    assert.deepEqual(terminal.highlightWindow, [])
    assert.deepEqual(terminal.captions, [])
    assert.deepEqual(terminal.pending, [])
    assert.deepEqual(terminal.approvals, [])
  }
})
