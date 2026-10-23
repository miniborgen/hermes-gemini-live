const VERTEX = `
attribute vec3 aPosition;
uniform float uTime;
uniform float uLevel;
uniform vec2 uAspect;
varying float vHeat;
void main() {
  vec3 p = aPosition;
  float wobble = sin(p.y * 4.0 + uTime * 0.7) * 0.10 + cos(p.x * 5.0 - uTime * 0.45) * 0.07;
  p.z += wobble * (0.45 + uLevel);
  p.xy *= uAspect;
  vHeat = clamp(0.45 + p.y * 0.32 + wobble, 0.0, 1.0);
  gl_Position = vec4(p, 1.0);
}`

const FRAGMENT = `
precision mediump float;
uniform float uTime;
uniform float uLevel;
varying float vHeat;
float grain(vec2 p) { return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime) * 43758.5453); }
void main() {
  vec3 rust = vec3(0.55, 0.15, 0.055);
  vec3 ember = vec3(1.0, 0.48, 0.15);
  vec3 cream = vec3(1.0, 0.83, 0.55);
  vec3 color = mix(rust, ember, smoothstep(0.1, 0.8, vHeat));
  color = mix(color, cream, uLevel * 0.28);
  color += (grain(gl_FragCoord.xy) - 0.5) * 0.075;
  gl_FragColor = vec4(color, 0.82);
}`

function shader (gl, type, source) {
  const value = gl.createShader(type)
  gl.shaderSource(value, source)
  gl.compileShader(value)
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value))
  return value
}

function mesh () {
  const vertices = []
  const bands = 22
  const slices = 30
  for (let y = 0; y < bands; y++) {
    const v0 = y / bands
    const v1 = (y + 1) / bands
    for (let x = 0; x <= slices; x++) {
      const u = x / slices
      for (const v of [v0, v1]) {
        const latitude = (v - 0.5) * Math.PI
        const longitude = u * Math.PI * 2
        const radius = 0.55 + 0.08 * Math.sin(longitude * 3) * Math.cos(latitude * 2)
        vertices.push(Math.cos(latitude) * Math.cos(longitude) * radius,
          Math.sin(latitude) * radius * 1.15,
          Math.cos(latitude) * Math.sin(longitude) * radius)
      }
    }
  }
  return new Float32Array(vertices)
}

export function createPresenceRenderer (canvas, { reducedMotion = false } = {}) {
  const gl = canvas?.getContext?.('webgl', { alpha: true, antialias: true, premultipliedAlpha: true })
  if (!gl) return { available: false, setLevel () {}, destroy () {} }
  let stopped = false
  let level = 0
  let frame = 0
  const program = gl.createProgram()
  gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
  const data = mesh()
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'aPosition')
  const time = gl.getUniformLocation(program, 'uTime')
  const volume = gl.getUniformLocation(program, 'uLevel')
  const aspect = gl.getUniformLocation(program, 'uAspect')

  function draw (stamp = 0) {
    if (stopped) return
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0)
    gl.uniform1f(time, reducedMotion ? 0 : stamp / 1000)
    gl.uniform1f(volume, level)
    gl.uniform2f(aspect, height / Math.max(width, height), width / Math.max(width, height))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, data.length / 3)
    frame = requestAnimationFrame(draw)
  }
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    stopped = true
    cancelAnimationFrame(frame)
    canvas.hidden = true
  }, { once: true })
  frame = requestAnimationFrame(draw)
  return {
    available: true,
    setLevel (value) { level = Math.max(0, Math.min(1, Number(value) || 0)) },
    destroy () { stopped = true; cancelAnimationFrame(frame); gl.deleteBuffer(buffer); gl.deleteProgram(program) }
  }
}
