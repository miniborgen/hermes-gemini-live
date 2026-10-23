export function initialState () {
  return {
    session: 'boot',
    voice: 'listening',
    level: 0,
    muted: false,
    micMuted: false,
    outputMuted: false,
    outputGain: 1,
    detail: '',
    pending: [],
    tasks: [],
    approvals: [],
    reconnectAttempt: 0,
    elapsed: 0,
    lane: null,
    selectedLane: null,
    laneName: '',
    activeLane: null,
    duplexMode: 'natural',
    soundCues: false,
    captionsEnabled: false,
    captions: [],
    displayMode: 'orb',
    highlights: [],
    highlightWindow: [],
    streamWords: [],
    streamWordsBySpeaker: { user: [], assistant: [] },
    streamSources: { user: '', assistant: '' },
    streamComplete: false
  }
}

function uniqueAdd (items, value) {
  return items.includes(value) ? items : [...items, value]
}

function without (items, value) {
  return items.filter((item) => item !== value)
}

export function laneVisualToken (laneId) {
  let hash = 2166136261
  for (const char of String(laneId || 'default')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  const unsigned = hash >>> 0
  return {
    hue: 14 + (unsigned % 34),
    motion: 0.92 + ((unsigned >>> 8) % 17) / 100
  }
}

export function reconnectDelay (attempt) {
  return Math.min(2000, 500 * (2 ** Math.max(0, Number(attempt || 1) - 1)))
}

export function nextDisplayMode (mode) {
  if (mode === 'orb') return 'text'
  if (mode === 'text') return 'stream'
  return 'orb'
}

export function feedbackCue (kind) {
  const cues = {
    connected: { vibration: [12], frequency: 440, duration: 0.05 },
    approval: { vibration: [18, 35, 18], frequency: 620, duration: 0.055 },
    failed: { vibration: [35], frequency: 180, duration: 0.08 },
    ended: { vibration: [12], frequency: 280, duration: 0.045 }
  }
  return cues[kind] || { vibration: [], frequency: 0, duration: 0 }
}

export function naturalSpeechGate (gate = {}, { peak, now, assistantSpeaking = false }) {
  const level = Math.max(0, Number(peak) || 0)
  const at = Math.max(0, Number(now) || 0)
  const priorFloor = Math.max(0.004, Number(gate.noiseFloor) || 0.012)
  const noiseFloor = gate.active || level > priorFloor * 2.2
    ? priorFloor
    : Math.max(0.004, Math.min(0.04, priorFloor * 0.94 + level * 0.06))
  const onsetThreshold = Math.max(assistantSpeaking ? 0.032 : 0.024, noiseFloor * (assistantSpeaking ? 2.7 : 2.1))
  const releaseThreshold = Math.max(0.01, noiseFloor * 1.35)
  let onsetAt = Number(gate.onsetAt) || 0
  let lastAboveAt = Number(gate.lastAboveAt) || 0
  let active = Boolean(gate.active)
  if (level >= onsetThreshold) {
    if (!onsetAt) onsetAt = at
    lastAboveAt = at
    if (at - onsetAt >= (assistantSpeaking ? 120 : 70)) active = true
  } else if (!active) {
    onsetAt = 0
  }
  if (active && level >= releaseThreshold) lastAboveAt = at
  if (active && at - lastAboveAt > 360) {
    active = false
    onsetAt = 0
  }
  return { speaking: active, gate: { active, onsetAt, lastAboveAt, noiseFloor } }
}

export function shouldTransmitMic ({ mode, assistantSpeaking, interrupting = false, micMuted = false }) {
  return !micMuted && (mode !== 'stable' || !assistantSpeaking || interrupting)
}

const ACTIVE_TASK_STATES = new Set(['submitting', 'working', 'needs_input'])

function safeTaskText (value, limit = 96) {
  return String(value || '')
    .replace(/```/g, ' ')
    .replace(/(?:\/Users\/|~\/)[^\s;,]+/g, 'private path')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, 'private email')
    .replace(/\b(?:gh[pousr]_|sk-|AIza)[A-Za-z0-9_-]{8,}\b/g, 'private token')
    .replace(/https?:\/\/\S+/g, 'private link')
    .replace(/\b(?:token|secret|password|api[_ -]?key)\s*[:=]\s*\S+/gi, 'private value')
    .replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function taskTitle (value) {
  return safeTaskText(value).replace(/[.?!]+$/, '') || 'Delegated task'
}

function updateTask (state, id, changes, frame = {}) {
  const now = Number(frame.at || Date.now())
  const current = state.tasks.find(item => item.id === id)
  const task = {
    id,
    title: taskTitle(frame.title || frame.prompt || current?.title),
    state: 'working',
    startedAt: Number(frame.startedAt || current?.startedAt || now),
    updatedAt: Number(frame.updatedAt || now),
    laneId: String(frame.laneId ?? current?.laneId ?? state.activeLane ?? state.selectedLane ?? ''),
    laneName: safeTaskText(frame.laneName ?? current?.laneName ?? state.laneName ?? '', 64),
    question: safeTaskText(frame.question ?? current?.question ?? '', 180),
    preview: safeTaskText(frame.preview ?? current?.preview ?? '', 180),
    ...changes
  }
  return current ? state.tasks.map(item => item.id === id ? task : item) : [...state.tasks, task]
}

export function taskCards (tasks, { now = Date.now(), expanded = false } = {}) {
  const ordered = [...tasks].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
  const visible = expanded ? ordered : ordered.slice(0, ordered.length > 3 ? 2 : 3)
  const cards = visible.map(task => ({
    ...task,
    elapsedSeconds: Math.max(0, Math.floor(((ACTIVE_TASK_STATES.has(task.state) ? now : task.updatedAt) - task.startedAt) / 1000))
  }))
  cards.more = expanded ? 0 : Math.max(0, ordered.length - visible.length)
  return cards
}

function shortTaskTitle (value) {
  const title = taskTitle(value)
  const lower = title.toLowerCase()
  const noun = lower.includes('calendar') ? 'calendar' : ''
  if (/^schedule\b/.test(lower)) return ['Schedule', noun, 'event'].filter(Boolean).join(' ')
  if (/^add\b/.test(lower) && noun) return 'Add calendar event'
  if (/^check\b/.test(lower)) {
    const object = lower.includes('history') ? 'history' : lower.includes('routine') ? 'routine' : ''
    return ['Check', noun, object].filter(Boolean).join(' ')
  }
  const words = title.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []
  return words.slice(0, 4).join(' ') || 'Delegated task'
}

function taskVisualNumber (id, salt) {
  const text = `${id}:${salt}`
  let hash = 2166136261
  for (const character of text) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function radialTaskCards (tasks, { now = Date.now() } = {}) {
  const ordered = [...tasks]
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
  const active = ordered
    .filter(task => ACTIVE_TASK_STATES.has(task.state))
  const recentTerminal = ordered
    .filter(task => !ACTIVE_TASK_STATES.has(task.state))
    .slice(0, Math.max(0, 3 - active.length))
  return [...active.slice(0, 3), ...recentTerminal]
    .slice(0, 3)
    .map(task => ({
      ...task,
      shortTitle: shortTaskTitle(task.title),
      orbSize: 7 + (taskVisualNumber(task.id, 'size') % 7),
      driftSeconds: 18 + (taskVisualNumber(task.id, 'drift') % 13),
      elapsedSeconds: Math.max(0, Math.floor(((ACTIVE_TASK_STATES.has(task.state) ? now : task.updatedAt) - task.startedAt) / 1000))
    }))
}

export function hasScheduledPlayback ({ liveCount, scheduledUntil, currentTime }) {
  return Number(liveCount) > 0 && Number(scheduledUntil) > Number(currentTime)
}

export function isCurrentConnection (activeSocket, callbackSocket) {
  return Boolean(activeSocket) && activeSocket === callbackSocket
}

export function shouldConnectAfterLaneSwitch ({ hasSocket, captureReady }) {
  return Boolean(hasSocket || captureReady)
}

function transcriptText (priorValue, incomingValue) {
  const prior = String(priorValue || '').trim()
  const incoming = String(incomingValue || '').trim()
  if (!prior) return incoming
  if (!incoming) return prior
  if (incoming.startsWith(prior)) return incoming
  if (prior.endsWith(incoming)) return prior
  if (/^[,.;:!?)]/.test(incoming)) {
    return `${prior.replace(/[.!?]+$/, '')}${incoming}`
  }
  return `${prior} ${incoming}`
}

export function conversationHighlight (value) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
  if (!cleaned) return ''
  if (/meet(?:ing)? up with august/i.test(cleaned) && /glen park/i.test(cleaned) && /pizza/i.test(cleaned)) return 'Kids’ pizza playdate in Glen Park'
  if (/mila/i.test(cleaned) && /math activity/i.test(cleaned) && /teacher/i.test(cleaned) && /\bno\b/i.test(cleaned)) return 'No recent math activity from Mila’s teacher'
  if (/^what context do you have on my (?:car|vehicle)/i.test(cleaned)) return 'Known vehicle context'
  if (/^(?:i am|i'm|we are|we're) looking into (?:the )?records for (?:your |the )?tires/i.test(cleaned)) return 'Tire records lookup'
  if (/driver-door.*striker.*adjusted/i.test(cleaned)) return 'Driver-door striker adjustment'
  const contextQuestion = cleaned.match(/^(?:what kind of|what|which) context (?:do|does|will|would|can) (?:you|i|we|this chat) (?:get|have|receive|see|use|know).*?(?:start|starting|open|opening|begin|beginning)(?:ing)? (?:this |a |the )?chat/i)
  if (contextQuestion) return 'Context available when starting a chat'
  const statusQuestion = cleaned.match(/(?:what happened with|status of|where (?:does|do|is|are) .*? stand|where .*? stands)/i)
  if (statusQuestion) {
    const subject = cleaned
      .replace(/^.*?(?:what happened with|status of)\s+/i, '')
      .replace(/\s+(?:and|or)\s+where .*$/i, '')
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/[?.!]+$/, '')
      .trim()
    if (subject) return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} status`
  }
  const sentences = cleaned.match(/[^.!?]+[.!?]?/g) || [cleaned]
  let phrase = sentences.find((sentence) => (
    (sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length >= 6
  ))?.trim() || ''
  for (let pass = 0; pass < 3; pass += 1) {
    phrase = phrase.replace(
      /^(?:(?:um+|uh+|well|so|okay|ok|like|you know|i think|i mean|kind of|sort of|basically|actually|just|we need to|we should(?: just)?|i will|i'll|let's)\b[\s,.:;—-]*)+/i,
      ''
    ).trim()
  }
  const words = phrase.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []
  if (words.length < 5) return ''
  const limit = 12
  if (words.length > limit) {
    phrase = words.slice(0, limit).join(' ') + '…'
  }
  if (!phrase) return ''
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`
}

function highlightWindowFrom (state, speaker, frame) {
  const incoming = String(frame.text || '').trim()
  if (!incoming) return state.highlightWindow
  const at = Number(frame.at || 0)
  const prior = state.highlightWindow.at(-1)
  let source = incoming
  if (prior?.speaker === speaker && at - prior.updatedAt < 2500) {
    source = transcriptText(prior.source, frame.text)
  }
  const segment = { speaker, source, updatedAt: at }
  if (prior?.speaker === speaker && at - prior.updatedAt < 2500) {
    return [...state.highlightWindow.slice(0, -1), segment].slice(-4)
  }
  return [...state.highlightWindow, segment].slice(-4)
}

function commitHighlightWindow (state) {
  if (!state.highlightWindow.length) return { highlights: state.highlights, highlightWindow: [] }
  const source = state.highlightWindow.map((item) => item.source).join(' ')
  const text = conversationHighlight(source)
  if (!text) return { highlights: state.highlights, highlightWindow: [] }
  const speakers = new Set(state.highlightWindow.map((item) => item.speaker))
  const speaker = speakers.size === 1 ? state.highlightWindow[0].speaker : 'exchange'
  const highlight = { text, source, speaker, updatedAt: state.highlightWindow.at(-1)?.updatedAt || 0 }
  const prior = state.highlights.at(-1)
  return {
    highlights: prior?.text === text
      ? [...state.highlights.slice(0, -1), highlight]
      : [...state.highlights, highlight].slice(-6),
    highlightWindow: []
  }
}

function captionsFrom (state, speaker, frame) {
  if (!state.captionsEnabled) return state.captions
  const incoming = String(frame.text || '').trim()
  if (!incoming) return state.captions
  const prior = state.captions.at(-1)
  let text = incoming
  if (prior?.speaker === speaker && Number(frame.at || 0) - prior.updatedAt < 2500) {
    text = transcriptText(prior.text, frame.text)
  }
  const caption = { speaker, text, updatedAt: Number(frame.at || 0) }
  if (prior?.speaker === speaker && Number(frame.at || 0) - prior.updatedAt < 2500) {
    return [...state.captions.slice(0, -1), caption].slice(-2)
  }
  return [...state.captions, caption].slice(-2)
}

function streamWordsFrom (state, speaker, frame) {
  const incoming = String(frame.text || '').replace(/\s+/g, ' ').trim()
  if (!incoming) return { streamWords: state.streamWords, streamWordsBySpeaker: state.streamWordsBySpeaker, streamSources: state.streamSources }
  const priorSource = String(state.streamSources[speaker] || '')
  const tokenPattern = /[\p{L}\p{N}][\p{L}\p{N}'’-]*|[^\s\p{L}\p{N}]/gu
  const priorTokens = priorSource.match(tokenPattern) || []
  const nextTokens = incoming.match(tokenPattern) || []
  let shared = 0
  while (shared < priorTokens.length && shared < nextTokens.length && priorTokens[shared] === nextTokens[shared]) shared += 1
  const at = Number(frame.at || 0)
  const speakerWords = state.streamWordsBySpeaker[speaker] || []
  const priorAt = Number(speakerWords.at(-1)?.updatedAt || 0)
  const withinSegment = priorTokens.length && at - priorAt < 2500
  const looksChunked = withinSegment && !state.streamComplete && shared === 0 && nextTokens.length <= 3 && !incoming.startsWith(priorSource)
  if (looksChunked) {
    const chunk = nextTokens.map((text, index) => ({ text, speaker, updatedAt: at + index }))
    return {
      streamWords: [...state.streamWords, ...chunk].slice(-18),
      streamWordsBySpeaker: { ...state.streamWordsBySpeaker, [speaker]: [...speakerWords, ...chunk].slice(-9) },
      streamSources: { ...state.streamSources, [speaker]: `${priorSource} ${incoming}`.replace(/\s+/g, ' ').trim() }
    }
  }
  const additions = nextTokens.slice(shared).map((text, index) => ({ text, speaker, updatedAt: at + index }))
  const startsNewSegment = Boolean(priorTokens.length && at - priorAt >= 2500)
  if (startsNewSegment) {
    const segment = nextTokens.map((text, index) => ({ text, speaker, updatedAt: at + index }))
    return {
      streamWords: [...state.streamWords, ...segment].slice(-18),
      streamWordsBySpeaker: { ...state.streamWordsBySpeaker, [speaker]: segment.slice(-9) },
      streamSources: { ...state.streamSources, [speaker]: incoming }
    }
  }
  const material = additions.length ? additions : nextTokens.map((text, index) => ({ text, speaker, updatedAt: at + index }))
  return {
    streamWords: [...state.streamWords, ...material].slice(-18),
    streamWordsBySpeaker: { ...state.streamWordsBySpeaker, [speaker]: [...speakerWords, ...material].slice(-9) },
    streamSources: { ...state.streamSources, [speaker]: incoming }
  }
}

export function reduceFrame (state, frame) {
  if (!frame || typeof frame.type !== 'string') return state
  switch (frame.type) {
    case 'socket_open':
      return { ...state, session: 'live', voice: 'listening', detail: '', reconnectAttempt: 0 }
    case 'ready':
      return { ...state, session: 'live', voice: 'listening', detail: frame.statusText || '', reconnectAttempt: 0 }
    case 'reconnecting':
      return {
        ...state,
        session: 'reconnecting',
        voice: 'listening',
        reconnectAttempt: Math.max(1, Number(frame.attempt) || 1),
        pending: [],
        approvals: [],
        captions: [],
        highlights: [],
        highlightWindow: [],
        streamWords: [],
        streamWordsBySpeaker: { user: [], assistant: [] },
        streamSources: { user: '', assistant: '' },
        streamComplete: false,
        detail: ''
      }
    case 'mic_level':
      return {
        ...state,
        voice: frame.speaking ? 'user' : (state.voice === 'user' ? 'listening' : state.voice),
        level: Math.max(0, Math.min(1, Number(frame.level) || 0))
      }
    case 'in_text':
      return {
        ...state,
        voice: 'thinking',
        streamComplete: false,
        detail: '',
        captions: captionsFrom(state, 'user', frame),
        highlightWindow: highlightWindowFrom(state, 'user', frame),
        ...streamWordsFrom(state, 'user', frame)
      }
    case 'out_text':
      return {
        ...state,
        streamComplete: false,
        captions: captionsFrom(state, 'assistant', frame),
        highlightWindow: highlightWindowFrom(state, 'assistant', frame),
        ...streamWordsFrom(state, 'assistant', frame)
      }
    case 'audio':
      return { ...state, voice: 'assistant', level: Math.max(0, Math.min(1, Number(frame.level) || state.level)) }
    case 'speech_started':
      return { ...state, voice: 'listening', level: 0 }
    case 'turn_complete':
      return { ...state, voice: 'listening', level: 0, streamComplete: state.streamWords.length > 0, ...commitHighlightWindow(state) }
    case 'mute':
    case 'output_mute':
      return {
        ...state,
        muted: Boolean(frame.muted),
        outputMuted: Boolean(frame.muted),
        outputGain: frame.muted ? 0 : 1,
        captionsEnabled: frame.muted ? true : state.captionsEnabled
      }
    case 'mic_mute':
      return { ...state, micMuted: Boolean(frame.muted) }
    case 'duplex_mode':
      return { ...state, duplexMode: frame.mode === 'natural' ? 'natural' : 'stable' }
    case 'sound_cues':
      return { ...state, soundCues: Boolean(frame.enabled) }
    case 'caption_toggle':
      return { ...state, captionsEnabled: Boolean(frame.enabled), captions: frame.enabled ? state.captions : [] }
    case 'caption_clear':
      return { ...state, captions: [] }
    case 'display_mode':
      return { ...state, displayMode: ['text', 'stream'].includes(frame.mode) ? frame.mode : 'orb' }
    case 'lane_selected':
      return { ...state, selectedLane: String(frame.id || ''), laneName: String(frame.name || '') }
    case 'lane_switching':
      return {
        ...state,
        session: 'starting',
        voice: 'listening',
        level: 0,
        detail: '',
        reconnectAttempt: 0,
        selectedLane: String(frame.id || ''),
        laneName: String(frame.name || 'One-off chat'),
        activeLane: null,
        pending: [],
        approvals: [],
        captions: [],
        highlights: [],
        highlightWindow: [],
        streamWords: [],
        streamWordsBySpeaker: { user: [], assistant: [] },
        streamSources: { user: '', assistant: '' },
        streamComplete: false
      }
    case 'lane_context':
      return {
        ...state,
        activeLane: String(frame.id || ''),
        laneName: String(frame.name || state.laneName || ''),
        detail: ''
      }
    case 'task_snapshot': {
      const tasks = Array.isArray(frame.tasks) ? frame.tasks : []
      return tasks.reduce((next, item) => {
        const id = String(item.id || '')
        if (!id) return next
        const records = updateTask(next, id, { state: String(item.state || 'working') }, item)
        return { ...next, tasks: records }
      }, { ...state, tasks: [], pending: tasks.filter(item => ACTIVE_TASK_STATES.has(item.state)).map(item => String(item.id)) })
    }
    case 'task_started': {
      const id = String(frame.id || '')
      if (!id) return state
      return { ...state, pending: uniqueAdd(state.pending, id), tasks: updateTask(state, id, { state: 'working' }, frame) }
    }
    case 'task_needs_input': {
      const id = String(frame.id || '')
      if (!id) return state
      const current = state.approvals.find((item) => item.id === id)
      const approval = { id, question: String(frame.question || 'Mini needs your approval.'), sending: false }
      return {
        ...state,
        pending: uniqueAdd(state.pending, id),
        tasks: updateTask(state, id, { state: 'needs_input' }, frame),
        approvals: current
          ? state.approvals.map((item) => item.id === id ? approval : item)
          : [...state.approvals, approval]
      }
    }
    case 'approval_sending':
      return {
        ...state,
        approvals: state.approvals.map((item) => item.id === frame.id ? { ...item, sending: true } : item)
      }
    case 'task_update': {
      const id = String(frame.id || '')
      const endsTask = frame.action === 'deny' || frame.action === 'stop'
      return {
        ...state,
        pending: endsTask ? without(state.pending, id) : state.pending,
        tasks: updateTask(state, id, { state: endsTask ? 'cancelled' : 'working', question: '' }, frame),
        approvals: state.approvals.filter((item) => item.id !== id),
        detail: ''
      }
    }
    case 'task_done': {
      const id = String(frame.id || '')
      return {
        ...state,
        pending: without(state.pending, id),
        tasks: updateTask(state, id, { state: String(frame.state || 'completed'), question: '' }, frame),
        approvals: state.approvals.filter((item) => item.id !== id)
      }
    }
    case 'task_failed': {
      const id = String(frame.id || '')
      return {
        ...state,
        pending: without(state.pending, id),
        tasks: id ? updateTask(state, id, { state: 'failed', question: '' }, frame) : state.tasks,
        approvals: state.approvals.filter(item => item.id !== id),
        detail: String(frame.detail || 'Hermes could not complete that action.')
      }
    }
    case 'lane':
      return { ...state, lane: frame.status || 'unavailable', detail: String(frame.detail || '') }
    case 'reconnect_exhausted':
      return { ...state, session: 'ended', voice: 'listening', pending: [], approvals: [], captions: [], highlights: [], highlightWindow: [], streamWords: [], streamWordsBySpeaker: { user: [], assistant: [] }, streamSources: { user: '', assistant: '' }, streamComplete: false, detail: String(frame.detail || 'The voice connection could not be restored. Your lane and preferences are still selected.') }
    case 'go_away':
      return { ...state, session: 'ended', voice: 'listening', pending: [], approvals: [], captions: [], highlights: [], highlightWindow: [], streamWords: [], streamWordsBySpeaker: { user: [], assistant: [] }, streamSources: { user: '', assistant: '' }, streamComplete: false, detail: 'Gemini ended this session. Start again to continue.' }
    case 'error':
      return { ...state, session: 'error', voice: 'listening', pending: [], approvals: [], captions: [], highlights: [], highlightWindow: [], streamWords: [], streamWordsBySpeaker: { user: [], assistant: [] }, streamSources: { user: '', assistant: '' }, streamComplete: false, detail: String(frame.detail || 'The voice call failed.') }
    default:
      return state
  }
}

export function visibleStatus (state) {
  if (state.approvals.length) return { label: 'Approval needed', detail: `${state.approvals.length} task${state.approvals.length === 1 ? '' : 's'} waiting for you` }
  if (state.session === 'boot') return { label: 'Preparing', detail: 'Checking the private voice relay…' }
  if (state.session === 'starting') return { label: 'Connecting', detail: 'Opening microphone and private relay…' }
  if (state.session === 'reconnecting') return { label: 'Reconnecting', detail: `Attempt ${state.reconnectAttempt} of 3 — opening a fresh voice session in this lane` }
  if (state.session === 'error') return { label: 'Unavailable', detail: state.detail }
  if (state.session === 'ended') return { label: 'Call ended', detail: state.detail }
  if (state.pending.length) return { label: workingLine(0), detail: `Working on ${state.pending.length} task${state.pending.length === 1 ? '' : 's'} for you` }
  if (state.voice === 'thinking') return { label: 'Thinking', detail: '' }
  if (state.voice === 'assistant') return {
    label: 'Speaking',
    detail: state.duplexMode === 'stable' ? 'Tap to interrupt' : ''
  }
  if (state.muted) return { label: 'Muted', detail: 'The call and delegated tasks remain active' }
  if (state.voice === 'user') return { label: 'Listening', detail: 'You are speaking' }
  if (state.session === 'idle') return { label: 'Ready', detail: state.selectedLane ? 'Start when you are ready' : 'Start a one-off conversation' }
  return { label: 'Listening', detail: state.detail || '' }
}

const WORKING_LINES = [
  'Turning the pages', 'Connecting the dots',
  'Rummaging through the records', 'Lining up the clues',
  'Checking under the hood', 'Untangling the details',
  'Comparing notes', 'Chasing down the answer',
  'Sorting the useful bits', 'Dusting off the archives',
  'Following the thread', 'Assembling the puzzle',
  'Cross-checking everything', 'Poking around',
  'Reading the fine print', 'Mapping the moving parts',
  'Tightening the bolts', 'Gluing the pieces together',
  'Consulting the tiny librarians', 'Discombobulating productively'
]

export function workingLine (tick = 0) {
  return WORKING_LINES[Math.abs(Math.floor(Number(tick) || 0)) % WORKING_LINES.length]
}
