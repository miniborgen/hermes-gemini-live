export function initialState () {
  return {
    session: 'boot',
    voice: 'listening',
    level: 0,
    muted: false,
    detail: '',
    pending: [],
    approvals: [],
    elapsed: 0,
    lane: null
  }
}

function uniqueAdd (items, value) {
  return items.includes(value) ? items : [...items, value]
}

function without (items, value) {
  return items.filter((item) => item !== value)
}

export function reduceFrame (state, frame) {
  if (!frame || typeof frame.type !== 'string') return state
  switch (frame.type) {
    case 'socket_open':
    case 'ready':
      return { ...state, session: 'live', voice: 'listening', detail: '' }
    case 'mic_level':
      return {
        ...state,
        voice: frame.speaking ? 'user' : (state.voice === 'user' ? 'listening' : state.voice),
        level: Math.max(0, Math.min(1, Number(frame.level) || 0))
      }
    case 'in_text':
      return { ...state, voice: 'thinking', detail: '' }
    case 'audio':
      return { ...state, voice: 'assistant', level: Math.max(0, Math.min(1, Number(frame.level) || state.level)) }
    case 'speech_started':
      return { ...state, voice: 'listening', level: 0 }
    case 'turn_complete':
      return { ...state, voice: 'listening', level: 0 }
    case 'mute':
      return { ...state, muted: Boolean(frame.muted) }
    case 'task_started':
      return { ...state, pending: uniqueAdd(state.pending, String(frame.id || '')) }
    case 'task_needs_input': {
      const id = String(frame.id || '')
      if (!id) return state
      const current = state.approvals.find((item) => item.id === id)
      const approval = { id, question: String(frame.question || 'Hermes needs your approval.'), sending: false }
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
  if (state.session === 'error') return { label: 'Unavailable', detail: state.detail }
  if (state.session === 'ended') return { label: 'Call ended', detail: state.detail }
  if (state.pending.length) return { label: 'Hermes is working', detail: `${state.pending.length} task${state.pending.length === 1 ? '' : 's'} in progress` }
  if (state.voice === 'thinking') return { label: 'Thinking', detail: '' }
  if (state.voice === 'assistant') return { label: 'Speaking', detail: '' }
  if (state.muted) return { label: 'Muted', detail: 'The call and delegated tasks remain active' }
  if (state.voice === 'user') return { label: 'Listening', detail: 'You are speaking' }
  if (state.session === 'idle') return { label: 'Ready', detail: 'Private on your tailnet' }
  return { label: 'Listening', detail: '' }
}
