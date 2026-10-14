export function initialState () {
  return {
    session: 'boot',
    voice: 'listening',
    level: 0,
    muted: false,
    detail: '',
    pending: [],
    approvals: [],
    reconnectAttempt: 0,
    elapsed: 0,
    lane: null,
    selectedLane: null,
    laneName: '',
    activeLane: null,
    duplexMode: 'stable',
    soundCues: false,
    captionsEnabled: false,
    captions: [],
    displayMode: 'orb',
    highlights: [],
    highlightWindow: []
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

export function feedbackCue (kind) {
  const cues = {
    connected: { vibration: [12], frequency: 440, duration: 0.05 },
    approval: { vibration: [18, 35, 18], frequency: 620, duration: 0.055 },
    failed: { vibration: [35], frequency: 180, duration: 0.08 },
    ended: { vibration: [12], frequency: 280, duration: 0.045 }
  }
  return cues[kind] || { vibration: [], frequency: 0, duration: 0 }
}

export function shouldTransmitMic ({ mode, assistantSpeaking, interrupting = false }) {
  return mode !== 'stable' || !assistantSpeaking || interrupting
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

export function reduceFrame (state, frame) {
  if (!frame || typeof frame.type !== 'string') return state
  switch (frame.type) {
    case 'socket_open':
    case 'ready':
      return { ...state, session: 'live', voice: 'listening', detail: '', reconnectAttempt: 0 }
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
        detail: '',
        captions: captionsFrom(state, 'user', frame),
        highlightWindow: highlightWindowFrom(state, 'user', frame)
      }
    case 'out_text':
      return {
        ...state,
        captions: captionsFrom(state, 'assistant', frame),
        highlightWindow: highlightWindowFrom(state, 'assistant', frame)
      }
    case 'audio':
      return { ...state, voice: 'assistant', level: Math.max(0, Math.min(1, Number(frame.level) || state.level)) }
    case 'speech_started':
      return { ...state, voice: 'listening', level: 0 }
    case 'turn_complete':
      return { ...state, voice: 'listening', level: 0, ...commitHighlightWindow(state) }
    case 'mute':
      return { ...state, muted: Boolean(frame.muted) }
    case 'duplex_mode':
      return { ...state, duplexMode: frame.mode === 'natural' ? 'natural' : 'stable' }
    case 'sound_cues':
      return { ...state, soundCues: Boolean(frame.enabled) }
    case 'caption_toggle':
      return { ...state, captionsEnabled: Boolean(frame.enabled), captions: frame.enabled ? state.captions : [] }
    case 'caption_clear':
      return { ...state, captions: [] }
    case 'display_mode':
      return { ...state, displayMode: frame.mode === 'text' ? 'text' : 'orb' }
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
        highlightWindow: []
      }
    case 'lane_context':
      return {
        ...state,
        activeLane: String(frame.id || ''),
        laneName: String(frame.name || state.laneName || ''),
        detail: ''
      }
    case 'task_started':
      return { ...state, pending: uniqueAdd(state.pending, String(frame.id || '')) }
    case 'task_needs_input': {
      const id = String(frame.id || '')
      if (!id) return state
      const current = state.approvals.find((item) => item.id === id)
      const approval = { id, question: String(frame.question || 'Mini needs your approval.'), sending: false }
      return {
        ...state,
        pending: uniqueAdd(state.pending, id),
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
        approvals: state.approvals.filter((item) => item.id !== id),
        detail: ''
      }
    }
    case 'task_done': {
      const id = String(frame.id || '')
      return {
        ...state,
        pending: without(state.pending, id),
        approvals: state.approvals.filter((item) => item.id !== id)
      }
    }
    case 'task_failed':
      return { ...state, detail: String(frame.detail || 'Hermes could not complete that action.') }
    case 'lane':
      return { ...state, lane: frame.status || 'unavailable', detail: String(frame.detail || '') }
    case 'go_away':
      return { ...state, session: 'ended', voice: 'listening', pending: [], approvals: [], captions: [], highlights: [], highlightWindow: [], detail: 'Gemini ended this session. Start again to continue.' }
    case 'error':
      return { ...state, session: 'error', voice: 'listening', pending: [], approvals: [], captions: [], highlights: [], highlightWindow: [], detail: String(frame.detail || 'The voice call failed.') }
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
  if (state.pending.length) return { label: 'Mini is working', detail: `${state.pending.length} task${state.pending.length === 1 ? '' : 's'} in progress` }
  if (state.voice === 'thinking') return { label: 'Thinking', detail: '' }
  if (state.voice === 'assistant') return {
    label: 'Speaking',
    detail: state.duplexMode === 'stable' ? 'Tap to interrupt' : ''
  }
  if (state.muted) return { label: 'Muted', detail: 'The call and delegated tasks remain active' }
  if (state.voice === 'user') return { label: 'Listening', detail: 'You are speaking' }
  if (state.session === 'idle') return { label: 'Ready', detail: state.selectedLane ? 'Start when you are ready' : 'Start a one-off conversation' }
  return { label: 'Listening', detail: '' }
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
