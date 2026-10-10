class ResampleToPcm extends AudioWorkletProcessor {
  constructor () {
    super()
    this.queue = new Float32Array(6400)
    this.length = 0
    this.carry = 0
  }

  push (frame) {
    if (this.length + frame.length > this.queue.length) {
      const grown = new Float32Array((this.queue.length + frame.length) * 2)
      grown.set(this.queue.subarray(0, this.length))
      this.queue = grown
    }
    this.queue.set(frame, this.length)
    this.length += frame.length
  }

  drain () {
    const step = sampleRate / 16000
    const out = new Int16Array(Math.max(0, Math.floor(this.length / step)))
    for (let i = 0; i < out.length; i++) {
      const at = i * step + this.carry
      const low = Math.floor(at)
      const high = Math.min(low + 1, this.length - 1)
      const value = this.queue[low] * (1 - (at - low)) + this.queue[high] * (at - low)
      out[i] = Math.max(-1, Math.min(1, value)) * 32767
    }
    const consumed = Math.floor(out.length * step)
    this.carry = (this.length / step) % 1
    this.queue.copyWithin(0, consumed)
    this.length -= consumed
    return out
  }

  process (inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel || !channel.length) return true
    this.push(channel)
    if (this.length >= Math.ceil(1600 * (sampleRate / 16000))) {
      const pcm = this.drain()
      let peak = 0
      for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]))
      this.port.postMessage({ pcm, peak: peak / 32767 }, [pcm.buffer])
    }
    return true
  }
}

registerProcessor('hermes-pcm-out', ResampleToPcm)
