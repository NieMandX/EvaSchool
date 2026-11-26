import { shoreGaussian } from './globe-shadow-kernel.js';
import { createLandVisibility } from './globe-visibility.js';
import { globeMaterial } from './globe-material.js';

const SCREEN_VERTEX = `
  attribute vec2 aPosition;
  varying EDGE_PRECISION vec2 vUV;
  void main() {
    vUV = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const LAND_TRANSFORM = `
  attribute vec3 aPosition;
  uniform mat3 uCamera;
  uniform vec4 uPose;
  uniform vec3 uOffset;
  vec4 clipLand(vec3 p) {
    return vec4(uPose.xy + p.xy * uPose.zw * uOffset.z + uOffset.xy, p.z - 1.0, 1.0);
  }
`;

const LAND_VERTEX = LAND_TRANSFORM + globeMaterial('glsl') + `
  uniform vec4 uColor;
  uniform vec3 uShade;
  uniform vec3 uRamp;
  varying EDGE_PRECISION vec4 vColor;
  void main() {
    vec3 p = uCamera * aPosition;
    gl_Position = clipLand(p);
    vec3 base = mix(uColor.rgb, uShade, clamp(p.y * uRamp.x + uRamp.y, 0.0, 1.0));
    vColor = vec4(porcelain(base, p, uRamp.z) * uColor.a, uColor.a);
  }
`;

const LAND = `
  varying EDGE_PRECISION vec4 vColor;
  void main() { gl_FragColor = vColor; }
`;

const MASK_VERTEX = LAND_TRANSFORM + `void main() { gl_Position = clipLand(uCamera * aPosition); }`;
const MASK = `uniform float uCoverage; void main() { gl_FragColor = vec4(uCoverage); }`;

const WATER = globeMaterial('glsl') + `
  varying EDGE_PRECISION vec2 vUV;
  uniform vec4 uDisk;
  uniform vec2 uSize;
  uniform vec3 uLight;
  uniform vec3 uMid;
  uniform vec3 uDark;
  void main() {
    vec2 p = (vUV - uDisk.xy) / uDisk.zw;
    // At the silhouette, (1-r²)/2 has the same slope as the signed distance 1-r.
    float depthSquared = 1.0 - dot(p, p);
    float edge = 0.5 * depthSquared * uSize.x;
    float fill = clamp(edge + 0.5, 0.0, 1.0);
    vec4 water = vec4(0.0);
    if (fill > 0.0) {
      vec3 n = vec3(p, sqrt(max(0.0, depthSquared)));
      vec3 rgb = enamel(uDark, uMid, uLight, n);
      water = vec4(rgb * fill, fill);
    }
    if (fill < 1.0) {
      vec2 q = (p - vec2(0.08, -0.984)) / vec2(0.87, uSize.y);
      float contact = max(0.0, 1.0 - length(q)) * (66.0 / 255.0) * (1.0 - fill);
      water += vec4(vec3(41.0, 70.0, 84.0) / 255.0 * contact, contact);
    }
    float rim = min(1.0, max(0.0, 0.9 - abs(edge))) * 0.18;
    gl_FragColor = vec4(vec3(66.0, 101.0, 113.0) / 255.0 * rim, rim) + water * (1.0 - rim);
  }
`;

const LINE_VERTEX = `
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec2 aCorner;
  uniform mat3 uCamera;
  uniform vec4 uPose;
  uniform vec2 uPixels;
  uniform float uReach;
  varying EDGE_PRECISION vec3 vEdge;
  void main() {
    vec3 a = uCamera * aStart;
    vec3 b = uCamera * aEnd;
    if (a.z < 0.0 && b.z < 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vEdge = vec3(0.0);
      return;
    }
    if (a.z < 0.0) a.xy = normalize(mix(a.xy, b.xy, a.z / (a.z - b.z)));
    if (b.z < 0.0) b.xy = normalize(mix(b.xy, a.xy, b.z / (b.z - a.z)));
    vec2 delta = (b.xy - a.xy) * uPose.zw / uPixels;
    float span = length(delta);
    vec2 dir = span > 0.0001 ? delta / span : vec2(1.0, 0.0);
    float along = (aCorner.x * 2.0 - 1.0) * uReach;
    float across = aCorner.y * uReach;
    vec2 normal = vec2(-dir.y, dir.x);
    vec2 point = mix(a.xy, b.xy, aCorner.x);
    gl_Position = vec4(uPose.xy + point * uPose.zw + (dir * along + normal * across) * uPixels, 0.0, 1.0);
    vEdge = vec3(span * aCorner.x + along, across, span);
  }
`;

const LINE = `
  uniform vec4 uColor;
  uniform float uReach;
  varying EDGE_PRECISION vec3 vEdge;
  void main() {
    float cap = max(0.0, max(-vEdge.x, vEdge.x - vEdge.z));
    float alpha = clamp(uReach - length(vec2(cap, vEdge.y)), 0.0, 1.0) * uColor.a;
    gl_FragColor = vec4(uColor.rgb * alpha, alpha);
  }
`;

const BLUR = `
  varying EDGE_PRECISION vec2 vUV;
  uniform sampler2D uMask;
  uniform vec4 uKernel;
  uniform vec2 uPairs[12];
  void main() {
    vec2 coverage = texture2D(uMask, vUV).rg * uKernel.z;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= uKernel.w) break;
      vec2 delta = uKernel.xy * uPairs[i].x;
      coverage += uPairs[i].y * (texture2D(uMask, vUV + delta).rg + texture2D(uMask, vUV - delta).rg);
    }
    gl_FragColor = vec4(coverage, 0.0, 0.0);
  }
`;

const SHORE = `
  varying EDGE_PRECISION vec2 vUV;
  uniform sampler2D uMask;
  uniform vec4 uDisk;
  uniform vec2 uSize;
  uniform vec4 uColor;
  uniform vec2 uChannel;
  void main() {
    float circle = clamp((1.0 - length((vUV - uDisk.xy) / uDisk.zw)) * uSize.x + 0.5, 0.0, 1.0);
    float alpha = dot(texture2D(uMask, vUV + vec2(0.0, uSize.y)).rg, uChannel) * uColor.a * circle;
    gl_FragColor = vec4(uColor.rgb * alpha, alpha);
  }
`;

const DEGREE = Math.PI / 180;
const EMPTY_LINES = new Float32Array(0);
const corners = new Float32Array([0, -1, 1, -1, 1, 1, 0, 1]);
const quad = [0, 1, 2, 0, 2, 3];
const LINES_PER_BATCH = 16384; // Four corners per line, 16-bit indices.
const liftShadow = [21 / 255, 54 / 255, 69 / 255];
const gridColor = [50 / 255, 92 / 255, 109 / 255];
const rgb = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
const byteOpacity = percent => Math.round(255 * percent / 100) / 255;

function lineVertices(segments) {
  const vertices = new Float32Array(segments.length / 6 * 4 * 8);
  let cursor = 0;
  for (let i = 0; i + 5 < segments.length; i += 6) {
    for (let corner = 0; corner < corners.length; corner += 2) {
      for (let j = 0; j < 6; j++) vertices[cursor++] = segments[i + j];
      vertices[cursor++] = corners[corner];
      vertices[cursor++] = corners[corner + 1];
    }
  }
  return vertices;
}

export function createWebGlGlobe(canvas, mesh, onFailure) {
  let gl;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, antialias: true, depth: false, stencil: true, premultipliedAlpha: true,
      powerPreference: 'low-power', failIfMajorPerformanceCaveat: true,
    });
  } catch { return null; }
  if (!gl?.getContextAttributes()?.stencil) return null;

  const buffers = [];
  const programs = [];
  const textures = [];
  const framebuffers = [];
  let width = 0, height = 0, ratio = 1;
  let maskWidth = 0, maskHeight = 0;
  let kernels = null;
  let disposed = false;
  let ready = false;

  function onLost(event) {
    event.preventDefault();
    fail(event);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    for (const program of programs) gl.deleteProgram(program);
    for (const texture of textures) gl.deleteTexture(texture);
    for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
  }

  function fail(error) {
    if (!disposed) {
      dispose();
      if (ready) onFailure?.(error);
    }
    return false;
  }

  try {
    const highFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision;
    const precision = highFloat ? 'highp' : 'mediump';
    const [maxWidth, maxHeight] = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.disable(gl.DITHER);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    function build(vertexCode, fragmentCode, attributes, uniforms) {
      const program = gl.createProgram();
      if (!program) throw new Error('WebGL program unavailable');
      programs.push(program);
      for (const [type, shaderCode] of [[gl.VERTEX_SHADER, vertexCode], [gl.FRAGMENT_SHADER, fragmentCode]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('WebGL shader unavailable');
        const shaderPrecision = type === gl.VERTEX_SHADER ? 'highp' : precision;
        gl.shaderSource(shader, `precision ${shaderPrecision} float;\n#define EDGE_PRECISION ${precision}\n${shaderCode}`);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const error = new Error(gl.getShaderInfoLog(shader));
          gl.deleteShader(shader);
          throw error;
        }
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      attributes.forEach((name, index) => gl.bindAttribLocation(program, index, name));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      return { program, ...Object.fromEntries(uniforms.map(name => [name, gl.getUniformLocation(program, name)])) };
    }

    function buffer(target, data, usage = gl.STATIC_DRAW) {
      const item = gl.createBuffer();
      if (!item) throw new Error('WebGL globe buffer unavailable');
      buffers.push(item);
      gl.bindBuffer(target, item);
      gl.bufferData(target, data, usage);
      return item;
    }

    const water = build(SCREEN_VERTEX, WATER, ['aPosition'], ['uDisk', 'uSize', 'uLight', 'uMid', 'uDark']);
    const land = build(LAND_VERTEX, LAND, ['aPosition'], ['uCamera', 'uPose', 'uOffset', 'uRamp', 'uColor', 'uShade']);
    const coverage = build(MASK_VERTEX, MASK, ['aPosition'], ['uCamera', 'uPose', 'uOffset', 'uCoverage']);
    const line = build(LINE_VERTEX, LINE, ['aStart', 'aEnd', 'aCorner'], ['uCamera', 'uPose', 'uPixels', 'uReach', 'uColor']);
    const blur = build(SCREEN_VERTEX, BLUR, ['aPosition'], ['uMask', 'uKernel', 'uPairs[0]']);
    const shore = build(SCREEN_VERTEX, SHORE, ['aPosition'], ['uMask', 'uDisk', 'uSize', 'uColor', 'uChannel']);
    const screen = buffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]));

    // Keep local indices for each polygon group so even a globe with >65k vertices
    // uses only two buffers and the core WebGL 16-bit index type.
    const groups = [...mesh.continents, ...mesh.countries.values()];
    const vertices = new Float32Array(groups.reduce((total, part) => total + part.vertices.length, 0));
    const indices = new Uint16Array(groups.reduce((total, part) => total + part.indices.length, 0));
    const ranges = new Map();
    let vStart = 0, iStart = 0;
    for (const part of groups) {
      if (part.vertices.length / 3 > 65536) throw new Error('WebGL globe mesh part exceeds 16-bit index range');
      vertices.set(part.vertices, vStart);
      indices.set(part.indices, iStart);
      ranges.set(part, { start: vStart * 4, offset: iStart * 2, count: part.indices.length });
      vStart += part.vertices.length;
      iStart += part.indices.length;
    }
    const mapVertices = buffer(gl.ARRAY_BUFFER, vertices);
    const mapIndices = buffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    const continents = mesh.continents.map(part => ({ range: ranges.get(part), field: part.field }));
    const selectLand = createLandVisibility(mesh.continents);
    let visibleLand;
    const instances = gl.getExtension('ANGLE_instanced_arrays');
    const cornerBuffer = instances && buffer(gl.ARRAY_BUFFER, corners);
    const lineElements = new Uint16Array((instances ? 1 : LINES_PER_BATCH) * 6);
    for (let i = 0; i < lineElements.length / 6; i++) {
      const first = i * 4;
      for (let j = 0; j < quad.length; j++) lineElements[i * 6 + j] = first + quad[j];
    }
    const lineIndices = buffer(gl.ELEMENT_ARRAY_BUFFER, lineElements);
    function lines(segments, usage) {
      const data = instances ? segments : lineVertices(segments);
      return { buffer: buffer(gl.ARRAY_BUFFER, data, usage), count: segments.length / 6 };
    }
    // ANGLE draws a contiguous run of endpoint instances. Core WebGL can
    // instead index the original four-corner quads, sharing their vertices.
    const borderData = instances ? new Float32Array(mesh.borders.length * 3) : mesh.borders;
    if (instances) borderData.set(mesh.borders);
    const localElements = instances ? null : new Uint16Array(mesh.borders.length * 2);
    let nextBorder = mesh.borders.length;
    let nextElement = 0;
    const countries = new Map();
    for (const [id, part] of mesh.countries) {
      const range = ranges.get(part);
      const faces = part.faces.map(([continent, first, count]) => ({
        continent, start: range.start, offset: range.offset + first * 2, count,
      }));
      const first = nextBorder;
      const batches = [];
      for (const [start, count] of part.borders) {
        if (instances) {
          borderData.set(mesh.borders.subarray(start * 6, (start + count) * 6), nextBorder);
        } else {
          for (let segment = start; segment < start + count; segment++) {
            const base = segment - segment % LINES_PER_BATCH;
            let batch = batches[batches.length - 1];
            if (!batch || batch.base !== base) {
              batch = { base, offset: nextElement * 2, count: 0 };
              batches.push(batch);
            }
            for (const corner of quad) localElements[nextElement++] = (segment - base) * 4 + corner;
            batch.count += 6;
          }
        }
        nextBorder += count * 6;
      }
      countries.set(id, { ...range, faces, batches, borderStart: first / 6, borderCount: (nextBorder - first) / 6 });
    }
    const localIndices = localElements && buffer(gl.ELEMENT_ARRAY_BUFFER, localElements);
    const borders = lines(borderData);
    borders.count = mesh.borders.length / 6;
    const grid = lines(mesh.grid ?? EMPTY_LINES);
    const detail = lines(EMPTY_LINES, gl.DYNAMIC_DRAW);
    const matrix = new Float32Array(9);
    let pose = [0, 0, 1, 1];
    let theme, colors;

    function refreshColors(settings) {
      if (theme === settings) return;
      theme = settings;
      colors = {
        light: rgb(settings.waterLight), mid: rgb(settings.waterMid), dark: rgb(settings.waterDark),
        shore: rgb(settings.shoreColor), border: rgb(settings.borderColor),
        land: continents.map(({ field }) => rgb(settings[field])),
      };
    }

    function resize(nextWidth, nextHeight, nextRatio) {
      if (disposed) return false;
      if (nextWidth === width && nextHeight === height && nextRatio === ratio) return true;
      if (nextWidth < 1 || nextHeight < 1 || nextRatio <= 0 || nextWidth > maxWidth || nextHeight > maxHeight) {
        return fail(new Error('WebGL globe dimensions unsupported'));
      }
      canvas.width = width = nextWidth;
      canvas.height = height = nextHeight;
      if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
        return fail(new Error('WebGL globe drawing buffer resize failed'));
      }
      ratio = nextRatio;
      return true;
    }

    function setDetail(segments) {
      if (disposed) return;
      const data = segments ?? EMPTY_LINES;
      gl.bindBuffer(gl.ARRAY_BUFFER, detail.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, instances ? data : lineVertices(data), gl.DYNAMIC_DRAW);
      detail.count = data.length / 6;
    }

    function beginScreen(pass) {
      gl.useProgram(pass.program);
      gl.disableVertexAttribArray(1);
      gl.disableVertexAttribArray(2);
      gl.bindBuffer(gl.ARRAY_BUFFER, screen);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }

    let fill = land;
    function beginLand(program = land) {
      fill = program;
      gl.useProgram(fill.program);
      gl.disableVertexAttribArray(1);
      gl.disableVertexAttribArray(2);
      gl.bindBuffer(gl.ARRAY_BUFFER, mapVertices);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mapIndices);
      gl.uniformMatrix3fv(fill.uCamera, false, matrix);
      gl.uniform4fv(fill.uPose, pose);
    }

    function offset(x = 0, y = 0, scale = 1) {
      gl.uniform3f(fill.uOffset, x * ratio * 2 / width, -y * ratio * 2 / height, scale);
    }

    function tint(color, alpha, shade = color, top = 1, bottom = -1, raised = 0) {
      gl.uniform4f(land.uColor, color[0], color[1], color[2], alpha);
      gl.uniform3fv(land.uShade, shade);
      gl.uniform3f(land.uRamp, -1 / (top - bottom), top / (top - bottom), raised);
    }

    function drawRange({ start, offset: indexOffset, count }) {
      if (!count) return;
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, start);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, indexOffset);
    }

    function drawFaces(alpha) {
      for (let i = 0; i < continents.length; i++) {
        if (!visibleLand[i].length) continue;
        tint(colors.land[i], alpha);
        drawContinent(i);
      }
    }

    function drawContinent(index) {
      const spans = visibleLand[index];
      if (!spans.length) return;
      const { start, offset } = continents[index].range;
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, start);
      for (let i = 0; i < spans.length; i += 2) {
        gl.drawElements(gl.TRIANGLES, spans[i + 1], gl.UNSIGNED_SHORT, offset + spans[i] * 2);
      }
    }

    function bindLineQuad(first) {
      const offset = first * 4 * 32;
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, offset);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, offset + 12);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, offset + 24);
    }

    function drawLines(group, color, size, alpha, country) {
      const count = country ? country.borderCount : group.count;
      if (!count || !size || !alpha) return;
      gl.useProgram(line.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, group.buffer);
      gl.enableVertexAttribArray(1);
      gl.enableVertexAttribArray(2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIndices);
      gl.uniformMatrix3fv(line.uCamera, false, matrix);
      gl.uniform4fv(line.uPose, pose);
      gl.uniform2f(line.uPixels, 2 / width, 2 / height);
      gl.uniform1f(line.uReach, size * ratio * .5 + .5);
      gl.uniform4f(line.uColor, color[0], color[1], color[2], alpha);
      if (instances) {
        const start = country ? country.borderStart : 0;
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, start * 24);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, start * 24 + 12);
        instances.vertexAttribDivisorANGLE(0, 1);
        instances.vertexAttribDivisorANGLE(1, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
        instances.drawElementsInstancedANGLE(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
        instances.vertexAttribDivisorANGLE(0, 0);
        instances.vertexAttribDivisorANGLE(1, 0);
        return;
      }
      if (country) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, localIndices);
        for (const batch of country.batches) {
          bindLineQuad(batch.base);
          gl.drawElements(gl.TRIANGLES, batch.count, gl.UNSIGNED_SHORT, batch.offset);
        }
        return;
      }
      for (let drawn = 0; drawn < count; drawn += LINES_PER_BATCH) {
        bindLineQuad(drawn);
        gl.drawElements(gl.TRIANGLES, Math.min(count - drawn, LINES_PER_BATCH) * 6, gl.UNSIGNED_SHORT, 0);
      }
    }

    function target() {
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      if (texture) textures.push(texture);
      if (framebuffer) framebuffers.push(framebuffer);
      if (!texture || !framebuffer) throw new Error('WebGL shore buffer unavailable');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, framebuffer };
    }

    const mask = target();
    const scratch = target();
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('WebGL globe setup failed');
    gl.enableVertexAttribArray(0);

    function shoreSize(cssWidth, cssHeight, quality, blurRadius) {
      const scale = Math.min(quality === 'lite' ? .25 : .42, 750 / Math.max(cssWidth, cssHeight));
      const nextWidth = Math.max(1, Math.round(cssWidth * scale));
      const nextHeight = Math.max(1, Math.round(cssHeight * scale));
      if (nextWidth !== maskWidth || nextHeight !== maskHeight) {
        maskWidth = nextWidth;
        maskHeight = nextHeight;
        if (Math.max(maskWidth, maskHeight) > textureLimit) throw new Error('WebGL shore dimensions unsupported');
        for (const { texture, framebuffer } of [mask, scratch]) {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maskWidth, maskHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error('WebGL shore buffer incomplete');
          }
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL shore buffer allocation failed');
        kernels = null;
      }
      if (kernels?.blur !== blurRadius || kernels.cssWidth !== cssWidth || kernels.cssHeight !== cssHeight) {
        kernels = {
          blur: blurRadius, cssWidth, cssHeight,
          horizontal: shoreGaussian(maskWidth, cssWidth, true, blurRadius),
          vertical: shoreGaussian(maskHeight, cssHeight, false, blurRadius),
        };
      }
    }

    function convolve(from, to, kernel) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform4f(blur.uKernel, kernel.stepX, kernel.stepY, kernel.center, kernel.count);
      gl.uniform2fv(blur['uPairs[0]'], kernel.pairs);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function drawShadowMask(cuts, lifted, baseShadow, cssWidth, cssHeight, quality, blurRadius) {
      shoreSize(cssWidth, cssHeight, quality, blurRadius);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mask.framebuffer);
      gl.viewport(0, 0, maskWidth, maskHeight);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT);
      beginLand(coverage);
      offset();
      if (baseShadow) {
        gl.colorMask(true, false, false, false);
        gl.uniform1f(coverage.uCoverage, 1);
        for (let i = 0; i < continents.length; i++) drawContinent(i);
      }
      if (baseShadow && cuts.length) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        for (const { range, cutOpacity } of cuts) {
          gl.uniform1f(coverage.uCoverage, cutOpacity);
          drawRange(range);
        }
        gl.disable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      if (lifted.length) {
        gl.colorMask(false, true, false, false);
        gl.enable(gl.BLEND);
        for (const { range, offsetX, offsetY, scale, opacity } of lifted) {
          offset(offsetX, offsetY, scale);
          gl.uniform1f(coverage.uCoverage, opacity);
          drawRange(range);
        }
        gl.disable(gl.BLEND);
      }
      gl.colorMask(true, true, true, true);
      if (blurRadius) {
        beginScreen(blur);
        convolve(mask, scratch, kernels.horizontal);
        convolve(scratch, mask, kernels.vertical);
      }
    }

    function compositeShadow(disk, radius, cssHeight, lift, color, opacity, accent) {
      beginScreen(shore);
      gl.bindTexture(gl.TEXTURE_2D, mask.texture);
      gl.uniform4fv(shore.uDisk, disk);
      gl.uniform2f(shore.uSize, Math.min(16384, radius * ratio), lift / cssHeight);
      gl.uniform2f(shore.uChannel, accent ? 0 : 1, accent ? 1 : 0);
      gl.uniform4f(shore.uColor, ...color, opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function drawLand(settings, cuts) {
      if (cuts.length) {
        beginLand(coverage);
        offset();
        gl.enable(gl.STENCIL_TEST);
        gl.colorMask(false, false, false, false);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        for (let i = 0; i < cuts.length; i++) {
          gl.stencilFunc(gl.ALWAYS, i + 1, 255);
          drawRange(cuts[i].range);
        }
        gl.colorMask(true, true, true, true);
        gl.stencilMask(0);
        gl.stencilFunc(gl.EQUAL, 0, 255);
      }
      beginLand();
      offset();
      drawFaces(1);
      const borderOpacity = byteOpacity(settings.borderOpacity);
      drawLines(borders, colors.border, settings.borderWidth, borderOpacity);
      drawLines(detail, colors.border, 1, borderOpacity);
      if (!cuts.length) return;

      for (let i = 0; i < cuts.length; i++) {
        const remaining = 1 - cuts[i].cutOpacity;
        if (remaining <= 0) continue;
        gl.stencilFunc(gl.EQUAL, i + 1, 255);
        beginLand();
        offset();
        const range = cuts[i].range;
        for (const face of range.faces) {
          tint(colors.land[face.continent], remaining);
          drawRange(face);
        }
        drawLines(borders, colors.border, settings.borderWidth, borderOpacity * remaining, range);
        drawLines(detail, colors.border, 1, borderOpacity * remaining);
      }
      gl.disable(gl.STENCIL_TEST);
    }

    function drawAccents(accents) {
      if (!accents.length) return;
      beginLand();
      for (const accent of accents) {
        const { range, offsetX = 0, offsetY = 0, scale = 1, opacity = 1, light, dark = light } = accent;
        offset(offsetX, offsetY, scale);
        tint(light, opacity, dark, accent.rampTop ?? 1, accent.rampBottom ?? -1, 1);
        drawRange(range);
      }
    }

    function clipBackdrop(x, y, radius) {
      // Outside this rectangle both the disk and its contact shadow are transparent.
      const shadowBottom = radius * .984 + Math.max(10, radius * .09);
      const left = Math.min(width, Math.max(0, Math.floor((x - radius) * ratio) - 2));
      const right = Math.max(0, Math.min(width, Math.ceil((x + radius) * ratio) + 2));
      const top = Math.min(height, Math.max(0, Math.floor((y - radius) * ratio) - 2));
      const bottom = Math.max(0, Math.min(height, Math.ceil((y + Math.max(radius, shadowBottom)) * ratio) + 2));
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(left, height - bottom, Math.max(0, right - left), Math.max(0, bottom - top));
    }

    function draw({ lon, lat, x, y, radius, settings, quality, accents = [] }) {
      if (disposed || !width || radius <= 0) return false;
      try {
        refreshColors(settings);
        const cssWidth = width / ratio, cssHeight = height / ratio;
        visibleLand = selectLand(lon, lat, x, y, radius, cssWidth, cssHeight);
        const lonR = lon * DEGREE, latR = lat * DEGREE;
        const sinLon = Math.sin(lonR), cosLon = Math.cos(lonR);
        const sinLat = Math.sin(latR), cosLat = Math.cos(latR);
        matrix.set([-sinLon, -sinLat * cosLon, cosLat * cosLon,
          cosLon, -sinLat * sinLon, cosLat * sinLon, 0, cosLat, sinLat]);
        const disk = [x / cssWidth, 1 - y / cssHeight, radius / cssWidth, radius / cssHeight];
        pose = [disk[0] * 2 - 1, disk[1] * 2 - 1, disk[2] * 2, disk[3] * 2];
        const lifts = [];
        for (const accent of accents) {
          const range = countries.get(String(accent.id));
          if (range && accent.opacity > 0) lifts.push({ ...accent, range });
        }
        const cuts = lifts.filter(accent => accent.cutOpacity > 0).slice(-254);
        const shaded = settings.hoverShadow
          ? lifts.filter(({ offsetX, offsetY, scale }) => offsetX || offsetY || (scale ?? 1) !== 1) : [];
        if (settings.shoreOpacity || shaded.length) {
          drawShadowMask(cuts, shaded, settings.shoreOpacity, cssWidth, cssHeight, quality, settings.shoreBlur);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.stencilMask(255);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT | (cuts.length ? gl.STENCIL_BUFFER_BIT : 0));
        clipBackdrop(x, y, radius);
        beginScreen(water);
        gl.uniform4fv(water.uDisk, disk);
        gl.uniform2f(water.uSize, Math.min(16384, radius * ratio), Math.max(10 / radius, .09));
        gl.uniform3fv(water.uLight, colors.light);
        gl.uniform3fv(water.uMid, colors.mid);
        gl.uniform3fv(water.uDark, colors.dark);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.enable(gl.BLEND);
        drawLines(grid, gridColor, .64, byteOpacity(settings.gridOpacity) * .67);
        if (settings.shoreOpacity) {
          compositeShadow(disk, radius, cssHeight, settings.shoreLift, colors.shore, byteOpacity(settings.shoreOpacity), false);
        }
        gl.disable(gl.SCISSOR_TEST);
        drawLand(settings, cuts);
        if (shaded.length) {
          clipBackdrop(x, y, radius);
          compositeShadow(disk, radius, cssHeight, 1.25, liftShadow, settings.hoverShadow * .0062, true);
          gl.disable(gl.SCISSOR_TEST);
        }
        drawAccents(lifts);
        return true;
      } catch (error) { return fail(error); }
    }

    canvas.addEventListener('webglcontextlost', onLost);
    ready = true;
    return { resize, draw, setDetail, dispose };
  } catch (error) {
    fail(error);
    return null;
  }
}
