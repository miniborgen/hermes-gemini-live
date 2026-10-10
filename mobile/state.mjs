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
    captions: []
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

function captionsFrom (state, speaker, frame) {
  if (!state.captionsEnabled) return state.captions
  const incoming = String(frame.text || '').trim()
  if (!incoming) return state.captions
  const prior = state.captions.at(-1)
  let text = incoming
  if (prior?.speaker === speaker && Number(frame.at || 0) - prior.updatedAt < 2500) {
    if (incoming.startsWith(prior.text)) text = incoming
    else if (prior.text.endsWith(incoming)) text = prior.text
    else text = `${prior.text}${/^\s/.test(frame.text || '') ? '' : ' '}${incoming}`
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
        detail: ''
      }
    case 'mic_level':
      return {
        ...state,
        voice: frame.speaking ? 'user' : (state.voice === 'user' ? 'listening' : state.voice),
        level: Math.max(0, Math.min(1, Number(frame.level) || 0))
      }
    case 'in_text':
      return { ...state, voice: 'thinking', detail: '', captions: captionsFrom(state, 'user', frame) }
    case 'out_text':
      return { ...state, captions: captionsFrom(state, 'assistant', frame) }
    case 'audio':
      return { ...state, voice: 'assistant', level: Math.max(0, Math.min(1, Number(frame.level) || state.level)) }
    case 'speech_started':
      return { ...state, voice: 'listening', level: 0 }
    case 'turn_complete':
      return { ...state, voice: 'listening', level: 0 }
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
        laneName: String(frame.name || 'General conversation'),
        activeLane: null,
        pending: [],
        approvals: [],
        captions: []
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
      return { ...state, session: 'ended', voice: 'listening', detail: 'Gemini ended this session. Start again to continue.' }
    case 'error':
      return { ...state, session: 'error', voice: 'listening', detail: String(frame.detail || 'The voice call failed.') }
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
    detail: state.duplexMode === 'stable' ? 'Tap the orb to interrupt' : ''
  }
  if (state.muted) return { label: 'Muted', detail: 'The call and delegated tasks remain active' }
  if (state.voice === 'user') return { label: 'Listening', detail: 'You are speaking' }
  if (state.session === 'idle') return { label: 'Ready', detail: state.selectedLane ? 'Start when you are ready' : 'Start a general conversation' }
  return { label: 'Listening', detail: state.laneName || '' }
}
