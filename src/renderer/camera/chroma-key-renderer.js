const KEY_MODES = { none: 0, chroma: 1, luma: 2 }
const NATIVE_ALPHA_MODE = 3

const VERTEX_SHADER = `
attribute vec2 a_position;
uniform vec2 u_uvScale;
uniform vec2 u_uvOffset;
uniform float u_mirror;
varying vec2 v_uv;

void main() {
  vec2 uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  if (u_mirror > 0.5) uv.x = 1.0 - uv.x;
  v_uv = u_uvOffset + uv * u_uvScale;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

// Chroma math matches OBS's Chroma Key filter, so its usual values (0.40 / 0.08 / 0.10) behave the same.
const FRAGMENT_SHADER = `
precision mediump float;

uniform sampler2D u_frame;
uniform int u_mode;
uniform vec2 u_keyCbCr;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;
uniform float u_lumaThreshold;
uniform float u_premultiplied;
varying vec2 v_uv;

vec2 toCbCr(vec3 rgb) {
  float y = dot(rgb, vec3(0.299, 0.587, 0.114));
  return vec2((rgb.b - y) * 0.565, (rgb.r - y) * 0.713);
}

void main() {
  vec4 texel = texture2D(u_frame, v_uv);
  vec3 rgb = texel.rgb;
  float alpha = 1.0;

  if (u_mode == 1) {
    float baseMask = distance(toCbCr(rgb), u_keyCbCr) - u_similarity;
    alpha = pow(clamp(baseMask / u_smoothness, 0.0, 1.0), 1.5);
    // Spill suppression: desaturate the green halo a soft mask leaves on edges.
    float spillMask = pow(clamp(baseMask / u_spill, 0.0, 1.0), 1.5);
    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3(luma), rgb, spillMask);
  } else if (u_mode == 2) {
    float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    alpha = smoothstep(u_lumaThreshold, u_lumaThreshold + u_smoothness, luma);
  } else if (u_mode == 3) {
    // NVIDIA's own alpha. DirectShow bytes are BGRA but were uploaded as RGBA: swizzle back.
    rgb = texel.bgr;
    alpha = texel.a;
    if (u_premultiplied > 0.5) {
      gl_FragColor = vec4(rgb, alpha);
      return;
    }
  }

  gl_FragColor = vec4(rgb * alpha, alpha); // the canvas expects premultiplied alpha
}
`

/**
 * Draws the camera into a transparent WebGL canvas. Two sources:
 *  - draw(video): getUserMedia frames, optionally keyed (chroma/luma) on the GPU.
 *  - drawPixels(frame): raw BGRA frames from the native helper, using their real alpha.
 * Returns null if WebGL is unavailable.
 */
export function createChromaKeyRenderer(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power'
  })
  if (!gl) return null

  const program = createProgram(gl)
  if (!program) return null
  gl.useProgram(program)

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
  // Camera frames are non-power-of-two: WebGL1 requires CLAMP_TO_EDGE and no mipmaps.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const uniform = (name) => gl.getUniformLocation(program, name)
  const u = {
    frame: uniform('u_frame'),
    mode: uniform('u_mode'),
    keyCbCr: uniform('u_keyCbCr'),
    similarity: uniform('u_similarity'),
    smoothness: uniform('u_smoothness'),
    spill: uniform('u_spill'),
    lumaThreshold: uniform('u_lumaThreshold'),
    premultiplied: uniform('u_premultiplied'),
    uvScale: uniform('u_uvScale'),
    uvOffset: uniform('u_uvOffset'),
    mirror: uniform('u_mirror')
  }
  gl.uniform1i(u.frame, 0)

  // Size of the texture currently allocated for raw frames (-1 = owned by the video path).
  let textureWidth = -1
  let textureHeight = -1

  // A GPU reset (driver crash, game switching modes...) loses the context: rebuild from scratch.
  canvas.addEventListener('webglcontextlost', (event) => event.preventDefault())
  canvas.addEventListener('webglcontextrestored', () => window.location.reload())

  const clear = () => {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  const prepare = (sourceWidth, sourceHeight, options) => {
    resizeToDisplaySize(canvas)
    gl.viewport(0, 0, canvas.width, canvas.height)
    const { scale, offset } = coverTransform(sourceWidth, sourceHeight, canvas.width, canvas.height)
    gl.uniform2f(u.uvScale, scale[0], scale[1])
    gl.uniform2f(u.uvOffset, offset[0], offset[1])
    gl.uniform1f(u.mirror, options.mirror ? 1 : 0)
  }

  const render = () => {
    clear()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  return {
    draw(video, options) {
      if (gl.isContextLost()) return
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
      textureWidth = textureHeight = -1
      prepare(video.videoWidth, video.videoHeight, options)

      const [cb, cr] = hexToCbCr(options.keyColor)
      gl.uniform1i(u.mode, KEY_MODES[options.keyMode] ?? 0)
      gl.uniform2f(u.keyCbCr, cb, cr)
      gl.uniform1f(u.similarity, options.similarity)
      gl.uniform1f(u.smoothness, Math.max(options.smoothness, 0.001))
      gl.uniform1f(u.spill, Math.max(options.spill, 0.001))
      gl.uniform1f(u.lumaThreshold, options.lumaThreshold)
      render()
    },

    /** frame = { width, height, pixels: Uint8Array BGRA top-down }. */
    drawPixels(frame, options, premultiplied) {
      if (gl.isContextLost()) return
      if (frame.width !== textureWidth || frame.height !== textureHeight) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.pixels)
        textureWidth = frame.width
        textureHeight = frame.height
      } else {
        // Same size: update in place instead of reallocating GPU memory every frame.
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, frame.pixels)
      }
      prepare(frame.width, frame.height, options)
      gl.uniform1i(u.mode, NATIVE_ALPHA_MODE)
      gl.uniform1f(u.premultiplied, premultiplied ? 1 : 0)
      render()
    },

    clear() {
      if (!gl.isContextLost()) clear()
    }
  }
}

function createProgram(gl) {
  const compile = (type, source) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    console.error('[chroma-key] Shader error:', gl.getShaderInfoLog(shader))
    return null
  }

  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vertex || !fragment) return null

  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program

  console.error('[chroma-key] Link error:', gl.getProgramInfoLog(program))
  return null
}

/** Canvas backing store follows its CSS size × devicePixelRatio, so it stays sharp. */
function resizeToDisplaySize(canvas) {
  const ratio = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
}

/** Equivalent of CSS object-fit: cover, expressed as a texture-coordinate crop. */
function coverTransform(sourceWidth, sourceHeight, canvasWidth, canvasHeight) {
  if (!sourceWidth || !sourceHeight) return { scale: [1, 1], offset: [0, 0] }

  const sourceAspect = sourceWidth / sourceHeight
  const canvasAspect = canvasWidth / canvasHeight
  if (sourceAspect > canvasAspect) {
    const scaleX = canvasAspect / sourceAspect
    return { scale: [scaleX, 1], offset: [(1 - scaleX) / 2, 0] }
  }
  const scaleY = sourceAspect / canvasAspect
  return { scale: [1, scaleY], offset: [0, (1 - scaleY) / 2] }
}

function hexToCbCr(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = ((value >> 16) & 0xff) / 255
  const g = ((value >> 8) & 0xff) / 255
  const b = (value & 0xff) / 255
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  return [(b - y) * 0.565, (r - y) * 0.713]
}
