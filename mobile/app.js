import { feedbackCue, hasScheduledPlayback, initialState, isCurrentConnection, laneVisualToken, reconnectDelay, reduceFrame, shouldTransmitMic, visibleStatus } from './state.mjs'

const SEND_RATE = 16000
const SPEECH_ON = 0.055
const SPEECH_OFF_MS = 350

const elements = {
  app: document.querySelector('#app'),
  statusLabel: document.querySelector('#status-label'),
  statusDetail: document.querySelector('#status-detail'),
  activeLane: document.querySelector('#active-lane'),
  elapsed: document.querySelector('#elapsed'),
  startButton: document.querySelector('#start-call'),
  startPanel: document.querySelector('#start-panel'),
  controls: document.querySelector('#call-controls'),
  orb: document.querySelector('#orb'),
  mute: document.querySelector('#mute-call'),
  captions: document.querySelector('#captions-call'),
  end: document.querySelector('#end-call'),
  approvalSheet: document.querySelector('#approval-sheet'),
  approvalQuestion: document.querySelector('#approval-question'),
  approvalCount: document.querySelector('#approval-count'),
  approve: document.querySelector('#approve-approval'),
  deny: document.querySelector('#deny-approval'),
  taskEmbers: document.querySelector('#task-embers'),
  restoreAudio: document.querySelector('#restore-audio'),
  toast: document.querySelector('#toast'),
  laneSelect: document.querySelector('#lane-select'),
  liveCaption: document.querySelector('#live-caption'),
  audioModes: [...document.querySelectorAll('input[name="audio-mode"]')],
  soundCues: document.querySelector('#sound-cues')
}

let state = initialState()
let socket = null
let audioContext = null
let mediaStream = null
let captureNode = null
let captureSource = null
let captureSink = null
let player = null
let startedAt = 0
let renderFrame = 0
let lastMicAbove = 0
let toastTimer = 0
let captionTimer = 0
let interruptUntil = 0
let reconnectTimer = 0
let intentionalClose = false

function dispatch (frame) {
  state = reduceFrame(state, frame)
  render()
}

function formatElapsed (seconds) {
  const safe = Math.max(0, Math.floor(seconds))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

function render () {
  const status = visibleStatus(state)
  elements.app.dataset.session = state.session
  elements.app.dataset.voice = state.voice
  elements.app.dataset.muted = String(state.muted)
  elements.app.dataset.duplex = state.duplexMode
  elements.app.dataset.working = String(state.pending.length > 0)
  const laneToken = laneVisualToken(state.activeLane || state.selectedLane)
  elements.app.style.setProperty('--lane-hue', String(laneToken.hue))
  elements.app.style.setProperty('--lane-motion', String(laneToken.motion))
  elements.statusLabel.textContent = status.label
  elements.statusDetail.textContent = status.detail || state.detail || ''
  elements.startButton.disabled = state.session !== 'idle' || !state.selectedLane
  elements.startButton.textContent = state.session === 'error' || state.session === 'ended' ? 'Start again' : 'Start voice'
  elements.startPanel.hidden = !['idle', 'error', 'ended'].includes(state.session)
  elements.controls.hidden = !['starting', 'live', 'reconnecting'].includes(state.session)
  elements.mute.setAttribute('aria-pressed', String(state.muted))
  elements.mute.querySelector('span:last-child').textContent = state.muted ? 'Unmute' : 'Mute'
  elements.mute.querySelector('.control-icon').textContent = state.muted ? '○' : '◉'
  elements.captions.setAttribute('aria-pressed', String(state.captionsEnabled))
  elements.captions.querySelector('span:last-child').textContent = state.captionsEnabled ? 'Captions on' : 'Captions'
  elements.orb.setAttribute('aria-label', state.session === 'idle' ? 'Start voice call' : status.label)
  elements.laneSelect.disabled = !['idle', 'error', 'ended'].includes(state.session)
  for (const input of elements.audioModes) {
    input.checked = input.value === state.duplexMode
    input.disabled = !['idle', 'error', 'ended'].includes(state.session)
  }
  elements.soundCues.checked = state.soundCues
  elements.soundCues.disabled = !['idle', 'error', 'ended'].includes(state.session)
  elements.activeLane.hidden = !state.laneName
  elements.activeLane.textContent = state.laneName
  const captions = state.captionsEnabled ? state.captions : []
  elements.liveCaption.hidden = !captions.length
  elements.liveCaption.replaceChildren(...captions.map((caption, index) => {
    const line = document.createElement('div')
    line.className = `caption-line${index === captions.length - 1 ? ' caption-current' : ''}`
    line.dataset.speaker = caption.speaker
    const speaker = document.createElement('span')
    speaker.textContent = caption.speaker === 'user' ? 'You' : 'Gemini'
    const text = document.createElement('p')
    text.textContent = caption.text
    line.append(speaker, text)
    return line
  }))

  const approval = state.approvals[0]
  elements.approvalSheet.hidden = !approval
  if (approval) {
    elements.approvalQuestion.textContent = approval.question
    elements.approvalCount.textContent = state.approvals.length > 1
      ? `Approval 1 of ${state.approvals.length}`
      : 'Approval needed'
    elements.approve.disabled = approval.sending
    elements.deny.disabled = approval.sending
    elements.approve.textContent = approval.sending ? 'Sending…' : 'Approve once'
  }

  const emberCount = Math.min(4, state.pending.length)
  if (elements.taskEmbers.childElementCount !== emberCount) {
    elements.taskEmbers.replaceChildren(...Array.from({ length: emberCount }, (_, index) => {
      const ember = document.createElement('i')
      ember.style.setProperty('--ember-index', index)
      ember.style.setProperty('--ember-count', emberCount)
      return ember
    }))
  }
}

function showToast (message) {
  window.clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.hidden = false
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true }, 3600)
}

function emitFeedback (kind) {
  const cue = feedbackCue(kind)
  if (cue.vibration.length) navigator.vibrate?.(cue.vibration)
  if (!state.soundCues || !audioContext || !cue.frequency) return
  try {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const now = audioContext.currentTime
    oscillator.frequency.value = cue.frequency
    oscillator.type = 'sine'
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + cue.duration)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start(now)
    oscillator.stop(now + cue.duration + 0.01)
  } catch {}
}

function bytesToBase64 (pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes (text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function pcmPeak (bytes) {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
  let peak = 0
  for (let i = 0; i < samples.length; i += 16) peak = Math.max(peak, Math.abs(samples[i]))
  return peak / 32767
}

function createPlayer (context) {
  const gain = context.createGain()
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.7
  const bins = new Uint8Array(analyser.frequencyBinCount)
  gain.connect(analyser)
  analyser.connect(context.destination)
  let next = 0
  const live = new Set()

  return {
    play (bytes) {
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
      const buffer = context.createBuffer(1, samples.length, 24000)
      const channel = buffer.getChannelData(0)
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32767
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(gain)
      next = Math.max(next, context.currentTime)
      node.start(next)
      next += buffer.duration
      live.add(node)
      node.onended = () => live.delete(node)
    },
    level () {
      analyser.getByteFrequencyData(bins)
      let peak = 0
      for (let i = 0; i < bins.length; i++) peak = Math.max(peak, bins[i])
      return Math.sqrt(peak / 255)
    },
    isPlaying () {
      return hasScheduledPlayback({
        liveCount: live.size,
        scheduledUntil: next,
        currentTime: context.currentTime
      })
    },
    flush () {
      for (const node of live) {
        try { node.stop() } catch {}
      }
      live.clear()
      next = 0
    },
    close () {
      this.flush()
      gain.disconnect()
      analyser.disconnect()
    }
  }
}

function handleMicChunk (pcm, peak) {
  const now = performance.now()
  if (peak >= SPEECH_ON) lastMicAbove = now
  const speaking = peak >= SPEECH_ON || now - lastMicAbove < SPEECH_OFF_MS
  const assistantSpeaking = player?.isPlaying() || false
  const send = shouldTransmitMic({
    mode: state.duplexMode,
    assistantSpeaking,
    interrupting: now < interruptUntil
  })
  if (!state.muted && send && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'audio', data: bytesToBase64(pcm) }))
  }
  const userSpeaking = speaking && send
  if (state.voice !== 'assistant' || userSpeaking) {
    dispatch({ type: 'mic_level', level: peak, speaking: userSpeaking })
  }
}

async function startCapture (context, stream) {
  const source = context.createMediaStreamSource(stream)
  const sink = context.createGain()
  sink.gain.value = 0
  source.connect(sink)
  sink.connect(context.destination)
  captureSource = source
  captureSink = sink

  if (context.audioWorklet && window.AudioWorkletNode) {
    try {
      await context.audioWorklet.addModule('./audio-worklet.js')
      const node = new AudioWorkletNode(context, 'hermes-pcm-out')
      node.port.onmessage = (event) => handleMicChunk(event.data.pcm, event.data.peak)
      source.connect(node)
      captureNode = node
      return
    } catch {
      // WebKit variants that reject worklet loading use the main-thread fallback below.
    }
  }

  const node = context.createScriptProcessor(2048, 1, 1)
  let carry = 0
  node.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const step = context.sampleRate / SEND_RATE
    const count = Math.floor(input.length / step)
    if (!count) return
    const pcm = new Int16Array(count)
    for (let i = 0; i < count; i++) {
      const at = i * step + carry
      pcm[i] = Math.max(-1, Math.min(1, input[Math.min(Math.floor(at), input.length - 1)])) * 32767
    }
    carry = (input.length / step) % 1
    let peak = 0
    for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]))
    handleMicChunk(pcm, peak / 32767)
  }
  source.connect(node)
  node.connect(sink)
  captureNode = node
}

function unlockAudio (context) {
  const buffer = context.createBuffer(1, 1, context.sampleRate)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start(0)
}

function socketUrl () {
  const url = new URL('./relay', window.location.href)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('lane', state.selectedLane)
  return url.toString()
}

function receiveFrame (event) {
  let frame
  try { frame = JSON.parse(event.data) } catch { return }

  if (frame.type === 'ready') {
    const resumedFresh = state.session === 'reconnecting'
    emitFeedback('connected')
    if (resumedFresh) showToast('Reconnected — fresh voice session, same lane')
  }

  if (frame.type === 'audio' && frame.data) {
    const bytes = base64ToBytes(frame.data)
    player?.play(bytes)
    dispatch({ type: 'audio', level: pcmPeak(bytes) })
    return
  }
  if (frame.type === 'speech_started') player?.flush()
  if (frame.type === 'task_needs_input') emitFeedback('approval')
  if (frame.type === 'task_failed') {
    emitFeedback('failed')
    if (frame.detail) showToast(frame.detail)
  }
  if (frame.type === 'in_text' || frame.type === 'out_text') {
    frame.at = Date.now()
    window.clearTimeout(captionTimer)
    elements.liveCaption.classList.remove('caption-fade')
    void elements.liveCaption.offsetWidth
    elements.liveCaption.classList.add('caption-fade')
    captionTimer = window.setTimeout(() => dispatch({ type: 'caption_clear' }), 6200)
  }
  dispatch(frame)
}

function animationLoop () {
  const assistantLevel = player?.level() || 0
  const shownLevel = state.voice === 'assistant' ? assistantLevel : state.level
  elements.orb.style.setProperty('--level', String(Math.max(0, Math.min(1, shownLevel))))
  if (startedAt && ['starting', 'live'].includes(state.session)) {
    elements.elapsed.textContent = formatElapsed((Date.now() - startedAt) / 1000)
  } else {
    elements.elapsed.textContent = '0:00'
  }
  renderFrame = window.requestAnimationFrame(animationLoop)
}

function connectSocket () {
  intentionalClose = false
  const connection = new WebSocket(socketUrl())
  socket = connection
  connection.onmessage = (event) => {
    if (isCurrentConnection(socket, connection)) receiveFrame(event)
  }
  connection.onerror = () => {
    if (isCurrentConnection(socket, connection)) showToast('The private relay could not connect.')
  }
  connection.onclose = () => {
    if (!isCurrentConnection(socket, connection)) return
    socket = null
    if (intentionalClose || !['starting', 'live', 'reconnecting'].includes(state.session)) return
    player?.flush()
    interruptUntil = 0
    scheduleReconnect()
  }
}

function scheduleReconnect () {
  if (state.reconnectAttempt >= 3) {
    state = {
      ...state,
      session: 'ended',
      voice: 'listening',
      detail: 'The voice connection could not be restored. Your lane and preferences are still selected.'
    }
    emitFeedback('failed')
    releaseResources(false)
    render()
    return
  }
  const nextAttempt = state.reconnectAttempt + 1
  dispatch({ type: 'reconnecting', attempt: nextAttempt })
  window.clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(connectSocket, reconnectDelay(nextAttempt))
}

async function startCall () {
  if (!['idle', 'error', 'ended'].includes(state.session) || !state.selectedLane) return
  await stopCall(false)
  state = {
    ...initialState(),
    session: 'starting',
    selectedLane: state.selectedLane,
    laneName: state.laneName,
    captionsEnabled: state.captionsEnabled,
    duplexMode: state.duplexMode,
    soundCues: state.soundCues
  }
  startedAt = Date.now()
  render()

  try {
    audioContext = new AudioContext()
    await audioContext.resume()
    unlockAudio(audioContext)
    player = createPlayer(audioContext)

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    for (const track of mediaStream.getAudioTracks()) {
      track.addEventListener('ended', checkAudioHealth)
      track.addEventListener('mute', checkAudioHealth)
    }
    await startCapture(audioContext, mediaStream)

    connectSocket()
  } catch (error) {
    state = { ...state, session: 'error', detail: error?.message || String(error) }
    releaseResources(true)
    render()
  }
}

function releaseResources (closeSocket = true) {
  window.clearTimeout(reconnectTimer)
  reconnectTimer = 0
  if (closeSocket) intentionalClose = true
  if (closeSocket && socket) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close' }))
      socket.close()
    } catch {}
  }
  socket = null
  interruptUntil = 0
  captureNode?.disconnect?.()
  captureSource?.disconnect?.()
  captureSink?.disconnect?.()
  captureNode = captureSource = captureSink = null
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  player?.close()
  player = null
  if (audioContext) void audioContext.close().catch(() => {})
  audioContext = null
  elements.restoreAudio.hidden = true
  startedAt = 0
}

async function stopCall (setIdle = true) {
  if (setIdle && ['starting', 'live', 'reconnecting'].includes(state.session)) emitFeedback('ended')
  releaseResources(true)
  if (setIdle) state = {
    ...initialState(),
    session: 'idle',
    selectedLane: state.selectedLane,
    laneName: state.laneName,
    captionsEnabled: state.captionsEnabled,
    duplexMode: state.duplexMode,
    soundCues: state.soundCues
  }
  render()
}

function toggleMute () {
  dispatch({ type: 'mute', muted: !state.muted })
}

function answerApproval (choice) {
  const approval = state.approvals[0]
  if (!approval || approval.sending || socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'approval', id: approval.id, choice }))
  dispatch({ type: 'approval_sending', id: approval.id })
}

function checkAudioHealth () {
  if (!['starting', 'live'].includes(state.session)) return
  const track = mediaStream?.getAudioTracks()[0]
  const healthy = audioContext?.state === 'running' && track?.readyState === 'live' && !track.muted
  elements.restoreAudio.hidden = healthy
  if (!healthy) elements.statusDetail.textContent = 'Audio paused while the app was away'
}

async function restoreAudio () {
  try {
    if (audioContext?.state === 'suspended') await audioContext.resume()
    const track = mediaStream?.getAudioTracks()[0]
    if (!track || track.readyState !== 'live') {
      mediaStream?.getTracks().forEach((item) => item.stop())
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      await startCapture(audioContext, mediaStream)
    }
    elements.restoreAudio.hidden = true
    render()
  } catch (error) {
    showToast(error?.message || 'Audio could not be restored.')
  }
}

async function boot () {
  try {
    const [statusResponse, lanesResponse] = await Promise.all([
      fetch('./status', { cache: 'no-store', credentials: 'same-origin' }),
      fetch('./lanes', { cache: 'no-store', credentials: 'same-origin' })
    ])
    const [statusPayload, lanesPayload] = await Promise.all([statusResponse.json(), lanesResponse.json()])
    if (!statusResponse.ok || !statusPayload.ok) throw new Error(statusPayload.detail || 'Private relay unavailable')
    if (!lanesResponse.ok || !Array.isArray(lanesPayload.lanes) || !lanesPayload.lanes.length) {
      throw new Error('No Telegram topic lanes are configured')
    }
    elements.laneSelect.replaceChildren(...lanesPayload.lanes.map((lane) => {
      const option = document.createElement('option')
      option.value = lane.id
      option.textContent = lane.name
      return option
    }))
    const remembered = localStorage.getItem('hermes-live-lane')
    const captionsEnabled = localStorage.getItem('hermes-live-captions') === 'on'
    const duplexMode = localStorage.getItem('hermes-live-duplex') === 'natural' ? 'natural' : 'stable'
    const soundCues = localStorage.getItem('hermes-live-sound-cues') === 'on'
    const selected = lanesPayload.lanes.find((lane) => lane.id === remembered) || lanesPayload.lanes[0]
    elements.laneSelect.value = selected.id
    state = {
      ...initialState(),
      session: 'idle',
      selectedLane: selected.id,
      laneName: selected.name,
      captionsEnabled,
      duplexMode,
      soundCues
    }
  } catch (error) {
    state = { ...initialState(), session: 'error', detail: error?.message || String(error) }
  }
  render()
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {})
}

elements.startButton.addEventListener('click', startCall)
elements.laneSelect.addEventListener('change', () => {
  const option = elements.laneSelect.selectedOptions[0]
  if (!option) return
  localStorage.setItem('hermes-live-lane', option.value)
  dispatch({ type: 'lane_selected', id: option.value, name: option.textContent })
})
elements.orb.addEventListener('click', () => {
  if (['idle', 'error', 'ended'].includes(state.session)) void startCall()
  else if (state.session === 'live' && state.voice === 'assistant' && state.duplexMode === 'stable') {
    interruptUntil = performance.now() + 2600
    player?.flush()
    dispatch({ type: 'speech_started' })
    navigator.vibrate?.(12)
    showToast('Listening — go ahead')
  }
})
for (const input of elements.audioModes) {
  input.addEventListener('change', () => {
    if (!input.checked) return
    localStorage.setItem('hermes-live-duplex', input.value)
    dispatch({ type: 'duplex_mode', mode: input.value })
  })
}
elements.soundCues.addEventListener('change', () => {
  localStorage.setItem('hermes-live-sound-cues', elements.soundCues.checked ? 'on' : 'off')
  dispatch({ type: 'sound_cues', enabled: elements.soundCues.checked })
})
elements.mute.addEventListener('click', toggleMute)
elements.captions.addEventListener('click', () => {
  const enabled = !state.captionsEnabled
  localStorage.setItem('hermes-live-captions', enabled ? 'on' : 'off')
  dispatch({ type: 'caption_toggle', enabled })
})
elements.end.addEventListener('click', () => void stopCall())
elements.approve.addEventListener('click', () => answerApproval('approve'))
elements.deny.addEventListener('click', () => answerApproval('deny'))
elements.restoreAudio.addEventListener('click', restoreAudio)
document.addEventListener('visibilitychange', checkAudioHealth)
window.addEventListener('pagehide', checkAudioHealth)
window.addEventListener('pageshow', checkAudioHealth)

render()
renderFrame = window.requestAnimationFrame(animationLoop)
window.addEventListener('beforeunload', () => {
  window.cancelAnimationFrame(renderFrame)
  window.clearTimeout(captionTimer)
  releaseResources(true)
})
void boot()
