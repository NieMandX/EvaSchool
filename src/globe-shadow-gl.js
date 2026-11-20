import { defaultShadowColor, shoreGaussian } from './globe-shadow-kernel.js';

const VERTEX = `
  attribute vec2 position;
  varying vec2 uv;
  void main() {
    uv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const BLUR = `
  varying vec2 uv;
  uniform sampler2D mask;
  uniform vec4 kernel;
  uniform vec2 pairs[12];
  void main() {
    float coverage = texture2D(mask, uv).a * kernel.z;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= kernel.w) break;
      vec2 delta = kernel.xy * pairs[i].x;
      coverage += pairs[i].y * (texture2D(mask, uv + delta).a + texture2D(mask, uv - delta).a);
    }
    gl_FragColor = vec4(0.0, 0.0, 0.0, coverage);
  }
`;

const SHORE = `
  varying vec2 uv;
  uniform sampler2D mask;
  uniform sampler2D aperture;
  uniform vec4 viewport;
  uniform vec4 relief;
  uniform vec4 color;
  void main() {
    // DOM uploads and blur targets store the top row at texture y = 0.
    vec2 point = vec2(uv.x, 1.0 - uv.y);
    float distanceFromCenter = distance(point * viewport.xy, viewport.zw);
    float circle = clamp((relief.x - distanceFromCenter) * relief.y + 0.5, 0.0, 1.0);
    float shadow = texture2D(mask, point - vec2(0.0, relief.z)).a;
    if (relief.w > 0.0) shadow *= 1.0 - texture2D(aperture, point).a;
    float alpha = shadow * circle * color.a;
    gl_FragColor = vec4(color.rgb * alpha, alpha);
  }
`;

export function createGlShoreShadow(canvas, onFailure) {
  const attributes = {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power', failIfMajorPerformanceCaveat: true,
  };
  let gl;
  try {
    gl = canvas.getContext('webgl', attributes) || canvas.getContext('experimental-webgl', attributes);
  } catch {
    return null;
  }
  if (!gl) return null;
  const textures = [];
  const framebuffers = [];
  const programs = [];
  let buffer;
  let disposed = false;
  let ready = false;
  let width = 0, height = 0, ratio = 1;
  let maskWidth = 0, maskHeight = 0;
  let cached = false;
  let kernelBlur, horizontal, vertical;

  function contextLost(event) {
    fail(new Error(event.statusMessage || 'WebGL context lost'));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', contextLost);
    textures.forEach(texture => gl.deleteTexture(texture));
    framebuffers.forEach(framebuffer => gl.deleteFramebuffer(framebuffer));
    programs.forEach(program => gl.deleteProgram(program));
    if (buffer) gl.deleteBuffer(buffer);
  }

  function fail(error) {
    if (!disposed) {
      dispose();
      if (ready) onFailure?.(error);
    }
    return false;
  }

  try {
    gl.disable(gl.DITHER);
    const highFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const precision = highFloat?.precision ? 'highp' : 'mediump';
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('WebGL shader creation failed');
      gl.shaderSource(shader, `precision ${precision} float;\n${source}`);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
      const error = new Error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      throw error;
    };

    function buildProgram(fragmentSource, uniforms) {
      const program = gl.createProgram();
      if (!program) throw new Error('WebGL program creation failed');
      programs.push(program);
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragmentSource]]) {
        const shader = compile(type, source);
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      gl.bindAttribLocation(program, 0, 'position');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const locations = Object.fromEntries(uniforms.map(name => [name, gl.getUniformLocation(program, name)]));
      return { program, ...locations };
    }

    const blurPass = buildProgram(BLUR, ['mask', 'kernel', 'pairs[0]']);
    const shorePass = buildProgram(SHORE, ['mask', 'aperture', 'viewport', 'relief', 'color']);
    gl.useProgram(blurPass.program);
    gl.uniform1i(blurPass.mask, 0);
    gl.useProgram(shorePass.program);
    gl.uniform1i(shorePass.mask, 0);
    gl.uniform1i(shorePass.aperture, 1);

    buffer = gl.createBuffer();
    if (!buffer) throw new Error('WebGL vertex buffer creation failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    function bind(texture, unit = 0) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }

    function createTexture() {
      const texture = gl.createTexture();
      if (!texture) throw new Error('WebGL texture creation failed');
      textures.push(texture);
      bind(texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    }

    function createTarget(texture) {
      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error('WebGL framebuffer creation failed');
      framebuffers.push(framebuffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return framebuffer;
    }

    const source = createTexture();
    const aperture = createTexture();
    const blurX = createTexture();
    const blurY = createTexture();
    const targetX = createTarget(blurX);
    const targetY = createTarget(blurY);
    const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const [maxWidth, maxHeight] = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('WebGL setup failed');

    function resize(nextWidth, nextHeight, nextRatio) {
      if (disposed) return false;
      if (nextWidth === width && nextHeight === height && nextRatio === ratio) return true;
      if (nextWidth < 1 || nextHeight < 1 || nextRatio <= 0 || nextWidth > maxWidth || nextHeight > maxHeight) {
        return fail(new Error('WebGL drawing buffer dimensions unsupported'));
      }
      canvas.width = width = nextWidth;
      canvas.height = height = nextHeight;
      ratio = nextRatio;
      if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
        return fail(new Error('WebGL drawing buffer resize failed'));
      }
      cached = false;
      return true;
    }

    function allocate(mask) {
      maskWidth = mask.width;
      maskHeight = mask.height;
      if (Math.min(maskWidth, maskHeight) < 1 || Math.max(maskWidth, maskHeight) > textureLimit) {
        throw new Error('WebGL shore mask dimensions unsupported');
      }
      for (const texture of textures) {
        bind(texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maskWidth, maskHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      for (const framebuffer of framebuffers) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('WebGL shore framebuffer incomplete');
        }
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL shore texture allocation failed');
      cached = false;
    }

    function upload(mask, texture) {
      if (mask.width !== maskWidth || mask.height !== maskHeight) throw new Error('WebGL shore masks must match');
      bind(texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask);
    }

    function convolve(input, target, kernel) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      bind(input);
      gl.uniform4f(blurPass.kernel, kernel.stepX, kernel.stepY, kernel.center, kernel.count);
      gl.uniform2fv(blurPass['pairs[0]'], kernel.pairs);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function draw({ landMask, cutMask, x, y, radius, lift = 3, blur = 8, color = defaultShadowColor }) {
      if (disposed || !width || (!landMask && !cached)) return false;
      try {
        if (landMask) {
          if (landMask.width !== maskWidth || landMask.height !== maskHeight) allocate(landMask);
          upload(landMask, source);
        }
        if (cutMask) upload(cutMask, aperture);
        const kernelChanged = !cached || kernelBlur !== blur;
        const cssWidth = width / ratio;
        const cssHeight = height / ratio;
        if (kernelChanged) {
          horizontal = shoreGaussian(maskWidth, cssWidth, true, blur);
          vertical = shoreGaussian(maskHeight, cssHeight, false, blur);
          kernelBlur = blur;
        }
        if (landMask || kernelChanged) {
          gl.useProgram(blurPass.program);
          gl.viewport(0, 0, maskWidth, maskHeight);
          convolve(source, targetX, horizontal);
          convolve(blurX, targetY, vertical);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(shorePass.program);
        gl.viewport(0, 0, width, height);
        bind(blurY);
        bind(cutMask ? aperture : source, 1);
        // Keep the circle calculation in range even on mediump-only fragment hardware.
        const scale = Math.max(cssWidth, cssHeight, radius);
        gl.uniform4f(shorePass.viewport, cssWidth / scale, cssHeight / scale, x / scale, y / scale);
        gl.uniform4f(shorePass.relief, radius / scale, Math.min(16_384, scale * ratio), lift / cssHeight, cutMask ? 1 : 0);
        gl.uniform4fv(shorePass.color, color);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        cached = true;
        return true;
      } catch (error) {
        return fail(error);
      }
    }

    canvas.addEventListener('webglcontextlost', contextLost);
    ready = true;
    return { resize, draw, dispose };
  } catch (error) {
    fail(error);
    return null;
  }
}
