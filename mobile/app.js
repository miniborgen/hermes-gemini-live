import { feedbackCue, hasScheduledPlayback, initialState, isCurrentConnection, laneVisualToken, reconnectDelay, reduceFrame, shouldConnectAfterLaneSwitch, shouldTransmitMic, visibleStatus, workingLine } from './state.mjs'

const SEND_RATE = 16000
const SPEECH_ON = 0.055
const SPEECH_OFF_MS = 350

const elements = {
  app: document.querySelector('#app'),
  statusLabel: document.querySelector('#status-label'),
  statusDetail: document.querySelector('#status-detail'),
  currentLane: document.querySelector('#current-lane'),
  elapsed: document.querySelector('#elapsed'),
  startButton: document.querySelector('#start-call'),
  startPanel: document.querySelector('#start-panel'),
  controls: document.querySelector('#call-controls'),
  orb: document.querySelector('#orb'),
  highlightStack: document.querySelector('#highlight-stack'),
  highlightAnnouncer: document.querySelector('#highlight-announcer'),
  viewOrb: document.querySelector('#view-orb'),
  viewText: document.querySelector('#view-text'),
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
  bargeIn: document.querySelector('#barge-in'),
  soundCues: document.querySelector('#sound-cues'),
  voiceSelect: document.querySelector('#voice-select'),
  drawerToggle: document.querySelector('#drawer-toggle'),
  drawerDismiss: document.querySelector('#drawer-dismiss'),
  settingsDrawer: document.querySelector('#settings-drawer'),
  topElapsed: document.querySelector('#top-elapsed'),
  topLane: document.querySelector('#top-lane'),
  bargeState: document.querySelector('#barge-state'),
  soundState: document.querySelector('#sound-state')
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
let renderedHighlightKey = null
let announcedHighlightKey = ''
let renderedCaptionKey = null
let pendingWorkerRefresh = false
const VOICES = new Set(['Aoede', 'Kore', 'Puck', 'Charon', 'Fenrir'])
let callId = sessionStorage.getItem('mini-live-call-id') || crypto.randomUUID()
sessionStorage.setItem('mini-live-call-id', callId)
let selectedVoice = 'Aoede'

function applyPendingWorkerRefresh () {
  if (!pendingWorkerRefresh) return
  if (['starting', 'live', 'reconnecting'].includes(state.session)) return
  pendingWorkerRefresh = false
  window.location.reload()
}

function dispatch (frame) {
  state = reduceFrame(state, frame)
  render()
}

function formatElapsed (seconds) {
  const safe = Math.max(0, Math.floor(seconds))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

function setText (element, value) {
  const text = String(value || '')
  if (element.textContent !== text) element.textContent = text
}

function render () {
  const status = visibleStatus(state)
  elements.app.dataset.session = state.session
  elements.app.dataset.voice = state.voice
  elements.app.dataset.muted = String(state.muted)
  elements.app.dataset.duplex = state.duplexMode
  elements.app.dataset.display = state.displayMode
  elements.app.dataset.working = String(state.pending.length > 0)
  const laneToken = laneVisualToken(state.activeLane || state.selectedLane)
  elements.app.style.setProperty('--lane-hue', String(laneToken.hue))
  elements.app.style.setProperty('--lane-motion', String(laneToken.motion))
  setText(elements.statusLabel, state.pending.length ? workingLine(Math.floor(Date.now() / 4200)) : status.label)
  setText(elements.statusDetail, status.detail || state.detail || '')
  elements.app.style.setProperty('--task-count', String(Math.min(4, state.pending.length)))
  setText(elements.currentLane, state.laneName || 'One-off chat')
  setText(elements.topLane, state.laneName || 'One-off chat')
  elements.startButton.disabled = !['idle', 'error', 'ended'].includes(state.session)
  elements.startButton.textContent = state.session === 'error' || state.session === 'ended' ? 'Start again' : 'Start voice'
  elements.startPanel.hidden = !['idle', 'error', 'ended'].includes(state.session)
  elements.controls.hidden = !['starting', 'live', 'reconnecting'].includes(state.session)
  elements.mute.setAttribute('aria-pressed', String(state.muted))
  elements.mute.querySelector('span:last-child').textContent = state.muted ? 'Unmute' : 'Mute'
  elements.mute.querySelector('.control-icon').textContent = state.muted ? '○' : '◉'
  elements.captions.setAttribute('aria-pressed', String(state.captionsEnabled))
  elements.captions.querySelector('span:last-child').textContent = state.captionsEnabled ? 'Captions on' : 'Captions'
  elements.orb.setAttribute('aria-label', state.session === 'idle' ? 'Start voice call' : status.label)
  elements.highlightStack.setAttribute('role', state.highlights.length ? 'list' : 'button')
  elements.highlightStack.setAttribute('tabindex', state.highlights.length ? '-1' : '0')
  elements.highlightStack.setAttribute('aria-label', state.highlights.length ? 'Conversation highlights' : (state.session === 'idle' ? 'Start voice call' : status.label))
  elements.highlightStack.removeAttribute('aria-description')
  elements.orb.hidden = state.displayMode === 'text'
  elements.highlightStack.hidden = state.displayMode !== 'text'
  elements.viewOrb.setAttribute('aria-pressed', String(state.displayMode === 'orb'))
  elements.viewText.setAttribute('aria-pressed', String(state.displayMode === 'text'))
  elements.laneSelect.disabled = state.session === 'boot'
  elements.bargeIn.checked = state.duplexMode === 'natural'
  elements.soundCues.checked = state.soundCues
  setText(elements.bargeState, state.duplexMode === 'natural' ? 'Barging' : 'Stable')
  setText(elements.soundState, state.soundCues ? 'Sound on' : 'Muted')
  elements.captions.hidden = state.displayMode === 'text'
  const captions = state.captionsEnabled ? state.captions : []
  const showCaptions = state.displayMode === 'orb' && captions.length > 0
  elements.liveCaption.hidden = !showCaptions
  const captionKey = showCaptions
    ? JSON.stringify(captions.map((caption) => [caption.speaker, caption.text, caption.updatedAt]))
    : 'hidden'
  if (captionKey !== renderedCaptionKey) {
    renderedCaptionKey = captionKey
    elements.liveCaption.replaceChildren(...(showCaptions ? captions.map((caption, index) => {
      const line = document.createElement('div')
      line.className = `caption-line${index === captions.length - 1 ? ' caption-current' : ''}`
      line.dataset.speaker = caption.speaker
      const speaker = document.createElement('span')
      speaker.textContent = caption.speaker === 'user' ? 'You' : 'Gemini'
      const text = document.createElement('p')
      text.textContent = caption.text
      line.append(speaker, text)
      return line
    }) : []))
  }

  const highlightKey = state.highlights.length
    ? JSON.stringify(state.highlights.map((highlight) => [highlight.text]))
    : `empty:${state.session}`
  if (state.displayMode !== 'text') {
    renderedHighlightKey = null
    announcedHighlightKey = ''
    if (elements.highlightStack.childElementCount) elements.highlightStack.replaceChildren()
    setText(elements.highlightAnnouncer, '')
  } else if (highlightKey !== renderedHighlightKey) {
    renderedHighlightKey = highlightKey
    if (!state.highlights.length) {
      announcedHighlightKey = ''
      elements.highlightAnnouncer.textContent = ''
      const empty = document.createElement('p')
      empty.className = 'highlight-empty'
      empty.textContent = ''
      elements.highlightStack.replaceChildren(empty)
    } else {
      elements.highlightStack.replaceChildren(...state.highlights.map((highlight, index) => {
        const item = document.createElement('div')
        item.className = 'highlight-item'
        item.setAttribute('role', 'listitem')
        item.dataset.age = String(state.highlights.length - index - 1)
        item.dataset.speaker = highlight.speaker || 'exchange'
        const marker = document.createElement('span')
        marker.className = 'highlight-speaker'
        marker.setAttribute('aria-hidden', 'true')
        marker.textContent = highlight.speaker === 'assistant' ? 'M' : highlight.speaker === 'user' ? 'Y' : ''
        const text = document.createElement('p')
        text.textContent = highlight.text
        item.append(marker, text)
        return item
      }))
      const latest = state.highlights.at(-1)
      const announceKey = latest ? `${latest.updatedAt}:${latest.text}` : ''
      if (announceKey && announceKey !== announcedHighlightKey) {
        announcedHighlightKey = announceKey
        elements.highlightAnnouncer.textContent = latest.text
      }
    }
  }

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

function playSoundCue (context, cue) {
  if (!context || !cue.frequency) return
  try {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const now = context.currentTime
    oscillator.frequency.value = cue.frequency
    oscillator.type = 'sine'
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.065, now + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + cue.duration)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + cue.duration + 0.01)
  } catch {}
}

function emitFeedback (kind) {
  const cue = feedbackCue(kind)
  if (cue.vibration.length) navigator.vibrate?.(cue.vibration)
  if (state.soundCues) playSoundCue(audioContext, cue)
}

async function playDetachedSoundCue (cue, guard = () => true) {
  let context = null
  try {
    context = new AudioContext()
    await context.resume()
    if (!guard()) return
    playSoundCue(context, cue)
    await new Promise((resolve) => window.setTimeout(resolve, Math.ceil((cue.duration + 0.04) * 1000)))
  } catch {}
  finally {
    if (context) await context.close().catch(() => {})
  }
}

function previewSoundCue () {
  if (!elements.soundCues.checked) return
  void playDetachedSoundCue(
    feedbackCue('connected'),
    () => elements.soundCues.checked && state.soundCues
  )
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
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (state.selectedLane) url.searchParams.set('lane', state.selectedLane)
  url.searchParams.set('call', callId)
  url.searchParams.set('voice', selectedVoice)
  return url.toString()
}

function receiveFrame (event) {
  let frame
  try { frame = JSON.parse(event.data) } catch { return }

  if (frame.type === 'ready') {
    const resumedFresh = state.session === 'reconnecting'
    emitFeedback('connected')
    if (resumedFresh) showToast(frame.resumed ? 'Resumed conversation' : 'Reconnected — continuity restored from Mini')
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
  const elapsedText = startedAt && ['starting', 'live'].includes(state.session)
    ? formatElapsed((Date.now() - startedAt) / 1000)
    : '0:00'
  setText(elements.elapsed, elapsedText)
  setText(elements.topElapsed, elapsedText)
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
      pending: [],
      approvals: [],
      captions: [],
      highlights: [],
      highlightWindow: [],
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
  if (!['idle', 'error', 'ended'].includes(state.session)) return
  setDrawer(false)
  await stopCall(false)
  state = {
    ...initialState(),
    session: 'starting',
    selectedLane: state.selectedLane,
    laneName: state.laneName,
    captionsEnabled: state.captionsEnabled,
    duplexMode: state.duplexMode,
    soundCues: state.soundCues,
    displayMode: state.displayMode
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

function closeRelayConnection () {
  window.clearTimeout(reconnectTimer)
  reconnectTimer = 0
  intentionalClose = true
  const connection = socket
  socket = null
  if (!connection) return
  try {
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'close' }))
    connection.close()
  } catch {}
}

function switchLane (id, name) {
  if (id === state.selectedLane) return
  const activeCall = ['starting', 'live', 'reconnecting'].includes(state.session)
  if (!activeCall) {
    dispatch({ type: 'lane_selected', id, name })
    return
  }
  const connectNow = shouldConnectAfterLaneSwitch({
    hasSocket: Boolean(socket),
    captureReady: Boolean(captureNode && mediaStream)
  })
  closeRelayConnection()
  player?.flush()
  interruptUntil = 0
  dispatch({ type: 'lane_switching', id, name })
  showToast(`Switching to ${name} — starting a fresh voice session`)
  if (connectNow) connectSocket()
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
  if (setIdle && ['starting', 'live', 'reconnecting'].includes(state.session)) {
    const cue = feedbackCue('ended')
    if (cue.vibration.length) navigator.vibrate?.(cue.vibration)
    if (state.soundCues) void playDetachedSoundCue(cue)
  }
  releaseResources(true)
  window.clearTimeout(captionTimer)
  captionTimer = 0
  renderedCaptionKey = null
  elements.liveCaption.classList.remove('caption-fade')
  elements.liveCaption.replaceChildren()
  if (setIdle) state = {
    ...initialState(),
    session: 'idle',
    selectedLane: state.selectedLane,
    laneName: state.laneName,
    captionsEnabled: state.captionsEnabled,
    duplexMode: state.duplexMode,
    soundCues: state.soundCues,
    displayMode: state.displayMode
  }
  render()
  applyPendingWorkerRefresh()
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
    if (!lanesResponse.ok || !Array.isArray(lanesPayload.lanes)) {
      throw new Error('Swim lanes are unavailable')
    }
    const general = { id: '', name: 'One-off chat' }
    const availableLanes = [general, ...lanesPayload.lanes]
    elements.laneSelect.replaceChildren(...availableLanes.map((lane) => {
      const option = document.createElement('option')
      option.value = lane.id
      option.textContent = lane.name
      return option
    }))
    const remembered = localStorage.getItem('hermes-live-lane')
    const captionsEnabled = localStorage.getItem('hermes-live-captions') === 'on'
    const duplexMode = localStorage.getItem('hermes-live-duplex') === 'natural' ? 'natural' : 'stable'
    const soundCues = localStorage.getItem('hermes-live-sound-cues') === 'on'
    const displayMode = localStorage.getItem('mini-live-display') === 'text' ? 'text' : 'orb'
    const storedVoice = localStorage.getItem('mini-live-voice')
    selectedVoice = VOICES.has(storedVoice) ? storedVoice : 'Aoede'
    elements.voiceSelect.value = selectedVoice
    const selected = availableLanes.find((lane) => lane.id === remembered) || general
    elements.laneSelect.value = selected.id
    state = {
      ...initialState(),
      session: 'idle',
      selectedLane: selected.id,
      laneName: selected.name,
      captionsEnabled,
      duplexMode,
      soundCues,
      displayMode
    }
  } catch (error) {
    state = { ...initialState(), session: 'error', detail: error?.message || String(error) }
  }
  render()
  if ('serviceWorker' in navigator) {
    let refreshingForWorker = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshingForWorker) return
      refreshingForWorker = true
      pendingWorkerRefresh = true
      applyPendingWorkerRefresh()
    })
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => {})
  }
}

elements.startButton.addEventListener('click', startCall)
function setDrawer (open) {
  elements.settingsDrawer.hidden = !open
  elements.drawerToggle.setAttribute('aria-expanded', String(open))
}
elements.drawerToggle.addEventListener('click', () => setDrawer(elements.settingsDrawer.hidden))
elements.drawerDismiss.addEventListener('click', () => setDrawer(false))
document.addEventListener('pointerdown', (event) => {
  if (elements.settingsDrawer.hidden) return
  if (elements.settingsDrawer.contains(event.target) || elements.drawerToggle.contains(event.target)) return
  setDrawer(false)
})
elements.laneSelect.addEventListener('change', () => {
  const option = elements.laneSelect.selectedOptions[0]
  if (!option) return
  if (option.value) localStorage.setItem('hermes-live-lane', option.value)
  else localStorage.removeItem('hermes-live-lane')
  switchLane(option.value, option.textContent)
  setDrawer(false)
})
function activateVoiceSurface () {
  if (['idle', 'error', 'ended'].includes(state.session)) void startCall()
  else if (state.session === 'live' && state.voice === 'assistant' && state.duplexMode === 'stable') {
    interruptUntil = performance.now() + 2600
    player?.flush()
    dispatch({ type: 'speech_started' })
    navigator.vibrate?.(12)
    showToast('Listening — go ahead')
  }
}
elements.orb.addEventListener('click', activateVoiceSurface)
elements.highlightStack.addEventListener('click', activateVoiceSurface)
elements.highlightStack.addEventListener('keydown', (event) => {
  if (state.highlights.length || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  activateVoiceSurface()
})
elements.bargeIn.addEventListener('change', () => {
  const mode = elements.bargeIn.checked ? 'natural' : 'stable'
  localStorage.setItem('hermes-live-duplex', mode)
  dispatch({ type: 'duplex_mode', mode })
})
elements.viewOrb.addEventListener('click', () => {
  localStorage.setItem('mini-live-display', 'orb')
  dispatch({ type: 'display_mode', mode: 'orb' })
})
elements.viewText.addEventListener('click', () => {
  localStorage.setItem('mini-live-display', 'text')
  dispatch({ type: 'display_mode', mode: 'text' })
})
elements.soundCues.addEventListener('change', () => {
  localStorage.setItem('hermes-live-sound-cues', elements.soundCues.checked ? 'on' : 'off')
  dispatch({ type: 'sound_cues', enabled: elements.soundCues.checked })
  if (elements.soundCues.checked) void previewSoundCue()
})
elements.voiceSelect.addEventListener('change', () => {
  const voice = VOICES.has(elements.voiceSelect.value) ? elements.voiceSelect.value : 'Aoede'
  if (voice === selectedVoice) return
  selectedVoice = voice
  localStorage.setItem('mini-live-voice', voice)
  if (['starting', 'live', 'reconnecting'].includes(state.session)) {
    closeRelayConnection()
    player?.flush()
    dispatch({ type: 'reconnecting', attempt: 1 })
    connectSocket()
    showToast(`Switching to ${voice}`)
  }
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
