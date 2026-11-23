import { shoreGaussian } from './globe-shadow-kernel.js';
import { createLandVisibility } from './globe-visibility.js';

const SAMPLES = 4;
const DEPTH_FORMAT = 'depth24plus-stencil8';
const SCENE_SIZE = 80;
const PAINT_SIZE = 64;
const RAD = Math.PI / 180;
const OVER = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

const QUAD = /* wgsl */ `
struct Quad { @builtin(position) clip: vec4f, @location(0) uv: vec2f }

@vertex fn quad(@builtin(vertex_index) index: u32) -> Quad {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return Quad(vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.5, 1.0), uv);
}
`;

const SCENE_SHADER = QUAD + /* wgsl */ `
struct Scene {
  east: vec4f,
  north: vec4f,
  front: vec4f,
  view: vec4f,
  sphere: vec4f,
}
struct Paint {
  transform: vec4f,
  light: vec4f,
  dark: vec4f,
  extra: vec4f,
}
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> paint: Paint;
@group(1) @binding(0) var blurred: texture_2d<f32>;
@group(1) @binding(1) var linear: sampler;

fn screen(point: vec3f) -> vec3f {
  let offset = vec2f(dot(scene.east.xyz, point), -dot(scene.north.xyz, point));
  let pixels = scene.view.zw + offset * scene.sphere.x * paint.transform.z + paint.transform.xy;
  return vec3f(pixels, dot(scene.front.xyz, point));
}

fn clipPosition(pixels: vec2f) -> vec4f {
  let ndc = pixels / scene.view.xy * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  return vec4f(ndc, 0.5, 1.0);
}

fn disk(pixels: vec2f) -> f32 {
  let radius = scene.sphere.x;
  let edge = (1.0 - distance(pixels, scene.view.zw) / radius) * min(radius * scene.sphere.y, 16384.0);
  return clamp(edge + 0.5, 0.0, 1.0);
}

fn premultiplied(rgb: vec3f, alpha: f32) -> vec4f { return vec4f(rgb * alpha, alpha); }

@fragment fn water(input: Quad) -> @location(0) vec4f {
  let pixels = input.uv * scene.view.xy;
  let radius = scene.sphere.x;
  let radial = (pixels - scene.view.zw) / radius;
  let edge = (1.0 - length(radial)) * min(radius * scene.sphere.y, 16384.0);
  let cover = clamp(edge + 0.5, 0.0, 1.0);
  var surface = vec4f(0.0);
  if (cover > 0.0) {
    let shift = vec2f(0.34, 0.43);
    let fromLight = radial + shift;
    let b = dot(fromLight, shift) + 0.0735;
    let gradient = clamp((sqrt(max(0.0, b * b + 0.802 * (dot(fromLight, fromLight) - 0.0049))) - b) / 0.802, 0.0, 1.0);
    let color = select(mix(paint.dark.rgb, paint.extra.rgb, (gradient - 0.63) / 0.37),
      mix(paint.light.rgb, paint.dark.rgb, gradient / 0.63), gradient < 0.63);
    surface = premultiplied(color, cover);
  }
  if (cover < 1.0) {
    let contactDistance = length((radial - vec2f(0.08, 0.984)) / vec2f(0.87, max(10.0 / radius, 0.09)));
    let contact = max(0.0, 1.0 - contactDistance) * (66.0 / 255.0) * (1.0 - cover);
    surface += premultiplied(vec3f(41.0, 70.0, 84.0) / 255.0, contact);
  }
  let rim = clamp(0.9 - abs(edge), 0.0, 1.0) * (116.0 / 255.0);
  return premultiplied(vec3f(66.0, 101.0, 113.0) / 255.0, rim) + surface * (1.0 - rim);
}

struct Fill {
  @builtin(position) clip: vec4f,
  @location(0) y: f32,
}

@vertex fn fill(@location(0) vertex: vec3f) -> Fill {
  let point = screen(vertex);
  var clip = clipPosition(point.xy);
  // The near plane is the horizon in WebGPU clip space (0 <= z <= w).
  clip.z = point.z * 0.5;
  return Fill(clip, point.y);
}

@fragment fn face(input: Fill) -> @location(0) vec4f {
  let ramp = clamp(0.5 + (input.y - scene.view.w) / (scene.sphere.x * 1.6), 0.0, 1.0);
  return premultiplied(mix(paint.light.rgb, paint.dark.rgb, ramp), paint.light.a);
}

@fragment fn mask() -> @location(0) vec4f {
  return premultiplied(paint.light.rgb, paint.light.a);
}

@fragment fn shadow(input: Quad) -> @location(0) vec4f {
  let pixels = input.uv * scene.view.xy;
  let uv = input.uv - paint.transform.xy / scene.view.xy;
  let coverage = textureSampleLevel(blurred, linear, uv, 0.0);
  let amount = select(coverage.r, coverage.g, paint.extra.x > 0.0) * disk(pixels);
  return premultiplied(paint.light.rgb, paint.light.a * amount);
}

struct Line {
  @builtin(position) clip: vec4f,
  @location(0) position: vec2f,
  @location(1) @interpolate(flat) span: f32,
}

@vertex fn line(@builtin(vertex_index) index: u32, @location(0) a: vec3f, @location(1) b: vec3f) -> Line {
  var p = screen(a);
  var q = screen(b);
  if (max(p.z, q.z) < 0.0) { return Line(vec4f(2.0, 2.0, 0.5, 1.0), vec2f(0.0), 0.0); }
  if (p.z < 0.0 && q.z > 0.0) { p = mix(p, q, p.z / (p.z - q.z)); }
  if (q.z < 0.0 && p.z > 0.0) { q = mix(q, p, q.z / (q.z - p.z)); }

  let delta = q.xy - p.xy;
  let span = length(delta);
  let axis = select(vec2f(1.0, 0.0), delta / max(span, 0.001), span > 0.001);
  let side = vec2f(-axis.y, axis.x);
  let reach = paint.transform.w * 0.5 + 0.7 / scene.sphere.y;
  let along = select(-reach, span + reach, index == 1u || index == 3u || index == 5u);
  let across = select(-reach, reach, index == 2u || index == 4u || index == 5u);
  let point = p.xy + axis * along + side * across;
  return Line(clipPosition(point), vec2f(along, across), span);
}

@fragment fn stroke(input: Line) -> @location(0) vec4f {
  let overhang = max(0.0, max(-input.position.x, input.position.x - input.span));
  let distance = length(vec2f(overhang, input.position.y));
  let alpha = clamp((paint.transform.w * 0.5 - distance) * scene.sphere.y + 0.5, 0.0, 1.0);
  let pixels = input.clip.xy / scene.sphere.y;
  return premultiplied(paint.light.rgb, paint.light.a * alpha * disk(pixels));
}
`;

const BLUR_SHADER = QUAD + /* wgsl */ `
struct Kernel { step: vec2f, count: f32, center: f32, pairs: array<vec4f, 12> }
@group(0) @binding(0) var mask: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var<uniform> kernel: Kernel;

@fragment fn gaussian(input: Quad) -> @location(0) vec4f {
  let uv = input.uv;
  var coverage = textureSampleLevel(mask, linear, uv, 0.0).rg * kernel.center;
  for (var i = 0; i < i32(kernel.count); i++) {
    let pair = kernel.pairs[i];
    let step = kernel.step * pair.x;
    coverage += pair.y * (textureSampleLevel(mask, linear, uv + step, 0.0).rg
                       + textureSampleLevel(mask, linear, uv - step, 0.0).rg);
  }
  return vec4f(coverage, 0.0, 0.0);
}
`;

const clamp01 = value => Math.max(0, Math.min(1, value));
const align = (value, multiple) => Math.ceil(value / multiple) * multiple;
const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);

function kernelUniform({ stepX, stepY, center, count, pairs }) {
  const data = new Float32Array(52);
  data.set([stepX, stepY, count, center]);
  for (let i = 0; i < count; i++) data.set(pairs.subarray(i * 2, i * 2 + 2), 4 + i * 4);
  return data;
}

function packedGeometry(mesh, upload) {
  const continents = [];
  const countries = new Map();
  const sources = [];
  let vertexCount = 0;
  let indexCount = 0;
  let wide = false;

  function add(shape) {
    const vertices = shape.vertices ?? shape;
    const indices = shape.indices;
    const range = { vertex: vertexCount, count: vertices.length / 3, index: indexCount, length: indices?.length ?? 0 };
    vertexCount += range.count;
    indexCount += range.length;
    wide ||= indices instanceof Uint32Array;
    sources.push({ vertices, indices, range });
    return range;
  }

  for (const continent of mesh.continents) continents.push({ field: continent.field, range: add(continent) });
  for (const [id, country] of mesh.countries) countries.set(id, add(country));
  const vertices = new Float32Array(vertexCount * 3);
  const indices = wide ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  for (const { vertices: source, indices: elements, range } of sources) {
    vertices.set(source, range.vertex * 3);
    if (elements) indices.set(elements, range.index);
  }
  return {
    vertices: upload(vertices, GPUBufferUsage.VERTEX), indices: upload(indices, GPUBufferUsage.INDEX),
    indexFormat: wide ? 'uint32' : 'uint16', continents, countries,
  };
}

export async function createWebGpuGlobe(canvas, mesh, onFailure) {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return null;
  let device, context;
  let ready = false;
  let disposed = false;
  let width = 0;
  let height = 0;
  let ratio = 1;
  const textures = new Set();
  const buffers = new Set();

  function dispose() {
    if (disposed) return;
    disposed = true;
    context?.unconfigure();
    for (const target of textures) target.destroy();
    for (const buffer of buffers) buffer.destroy();
    textures.clear();
    buffers.clear();
    device?.destroy();
  }

  function fail(error) {
    if (!disposed) {
      dispose();
      if (ready) onFailure?.(error);
    }
    return false;
  }

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'low-power' });
    if (!adapter || adapter.info?.isFallbackAdapter === true) return null;
    device = await adapter.requestDevice();
    device.lost.then(fail);
    device.addEventListener('uncapturederror', event => {
      event.preventDefault();
      fail(event.error);
    });
    context = canvas.getContext('webgpu');
    if (!context) {
      dispose();
      return null;
    }
    const format = gpu.getPreferredCanvasFormat();
    const stages = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const sceneLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: stages, buffer: { type: 'uniform', minBindingSize: SCENE_SIZE } },
        { binding: 1, visibility: stages, buffer: { type: 'uniform', minBindingSize: PAINT_SIZE, hasDynamicOffset: true } },
      ],
    });
    const shadowLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const scenePipeline = device.createPipelineLayout({ bindGroupLayouts: [sceneLayout] });
    const shadowPipeline = device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, shadowLayout] });
    const sceneModule = device.createShaderModule({ code: SCENE_SHADER });
    const gaussianModule = device.createShaderModule({ code: BLUR_SHADER });
    const fillAttributes = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }];
    const lineAttributes = [{
      arrayStride: 24, stepMode: 'instance',
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }],
    }];

    function pipeline(vertex, fragment, {
      target = format, writeMask = GPUColorWrite.ALL, blend, stencil, coverage = false, shadows = false, mask = false,
    } = {}) {
      const attributes = vertex === 'fill' ? fillAttributes : vertex === 'line' ? lineAttributes : [];
      const descriptor = {
        layout: shadows ? shadowPipeline : scenePipeline,
        vertex: { module: sceneModule, entryPoint: vertex, buffers: attributes },
        fragment: { module: sceneModule, entryPoint: fragment, targets: [{ format: target, writeMask, blend }] },
        // East × north faces the camera, so outward mesh triangles project counter-clockwise.
        primitive: vertex === 'fill' ? { frontFace: 'ccw', cullMode: 'back' } : {},
        multisample: { count: mask ? 1 : SAMPLES, alphaToCoverageEnabled: coverage },
      };
      if (!mask) {
        descriptor.depthStencil = {
          format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always',
          stencilFront: stencil, stencilBack: stencil,
          stencilReadMask: 255, stencilWriteMask: stencil?.passOp === 'replace' ? 255 : 0,
        };
      }
      return device.createRenderPipelineAsync(descriptor);
    }

    const cut = { compare: 'always', passOp: 'replace' };
    const outside = { compare: 'equal' };
    const maskTarget = { target: 'rgba8unorm', mask: true };
    const [
      ocean, coast, land, lines, cutter, lifted, shadowLand, shadowCut, shadowLift, gaussian,
    ] = await Promise.all([
      pipeline('quad', 'water'),
      pipeline('quad', 'shadow', { blend: OVER, shadows: true }),
      pipeline('fill', 'face', { stencil: outside }),
      pipeline('line', 'stroke', { blend: OVER, stencil: outside }),
      pipeline('fill', 'mask', { stencil: cut, coverage: true, writeMask: 0 }),
      pipeline('fill', 'face', { blend: OVER }),
      pipeline('fill', 'mask', { ...maskTarget, writeMask: GPUColorWrite.RED }),
      pipeline('fill', 'mask', { ...maskTarget, blend: OVER, writeMask: GPUColorWrite.RED }),
      pipeline('fill', 'mask', { ...maskTarget, blend: OVER, writeMask: GPUColorWrite.GREEN }),
      device.createRenderPipelineAsync({
        layout: 'auto', vertex: { module: gaussianModule, entryPoint: 'quad' },
        fragment: { module: gaussianModule, entryPoint: 'gaussian', targets: [{ format: 'rgba8unorm' }] },
      }),
    ]);
    if (disposed) return null;

    function makeBuffer(size, usage, mappedAtCreation = false) {
      const buffer = device.createBuffer({ size, usage, mappedAtCreation });
      buffers.add(buffer);
      return buffer;
    }

    function upload(data, usage) {
      if (!data?.byteLength) return null;
      const buffer = makeBuffer(align(data.byteLength, 4), usage, true);
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      buffer.unmap();
      return buffer;
    }

    function removeBuffer(buffer) {
      if (buffer) {
        buffers.delete(buffer);
        buffer.destroy();
      }
    }

    function segmentBuffer(vertices) {
      return vertices?.length ? { buffer: upload(vertices, GPUBufferUsage.VERTEX), count: vertices.length / 6 } : null;
    }

    device.pushErrorScope('validation');
    const geometry = packedGeometry(mesh, upload);
    const selectLand = createLandVisibility(mesh.continents);
    let visibleLand;
    const borders = segmentBuffer(mesh.borders);
    const grid = segmentBuffer(mesh.grid);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const uniformUsage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const sceneBuffer = makeBuffer(SCENE_SIZE, uniformUsage);
    const kernels = [makeBuffer(208, uniformUsage), makeBuffer(208, uniformUsage)];
    const scene = new Float32Array(SCENE_SIZE / 4);
    const stride = align(PAINT_SIZE, device.limits.minUniformBufferOffsetAlignment);
    let paintBuffer, paintData, group;
    let paintCount = 0;
    let screen;
    let shadow;
    let detailedData;
    let detail;
    let currentSettings;
    let palette;
    let previousBlur = NaN;

    function requirePaints(count) {
      if (paintData && paintData.length >= count * stride / 4) return;
      removeBuffer(paintBuffer);
      const capacity = 2 ** Math.ceil(Math.log2(count));
      paintBuffer = makeBuffer(capacity * stride, uniformUsage);
      paintData = new Float32Array(capacity * stride / 4);
      group = device.createBindGroup({
        layout: sceneLayout,
        entries: [
          { binding: 0, resource: { buffer: sceneBuffer, size: SCENE_SIZE } },
          { binding: 1, resource: { buffer: paintBuffer, size: PAINT_SIZE } },
        ],
      });
    }

    requirePaints(24);
    context.configure({ device, format, alphaMode: 'premultiplied' });
    const configError = await device.popErrorScope();
    if (configError || disposed) {
      dispose();
      return null;
    }

    function texture(size, format, sampleCount = 1, sampled = false) {
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | (sampled ? GPUTextureUsage.TEXTURE_BINDING : 0);
      const target = device.createTexture({ size, format, usage, sampleCount });
      textures.add(target);
      return target;
    }

    function removeTargets(targets) {
      for (const target of targets?.resources ?? []) {
        textures.delete(target);
        target.destroy();
      }
    }

    function setDetail(vertices) {
      if (disposed || detailedData === vertices) return;
      removeBuffer(detail?.buffer);
      detailedData = vertices;
      detail = segmentBuffer(vertices);
    }

    function resize(nextWidth, nextHeight, nextRatio = 1) {
      if (disposed) return false;
      if (width === nextWidth && height === nextHeight && ratio === nextRatio) return true;
      if (nextWidth < 1 || nextHeight < 1 || nextRatio <= 0 ||
          Math.max(nextWidth, nextHeight) > device.limits.maxTextureDimension2D) return fail();
      removeTargets(screen);
      removeTargets(shadow);
      screen = shadow = undefined;
      canvas.width = width = nextWidth;
      canvas.height = height = nextHeight;
      ratio = nextRatio;
      return true;
    }

    function requireScreen() {
      if (screen) return;
      const multisampled = texture([width, height], format, SAMPLES);
      const depth = texture([width, height], DEPTH_FORMAT, SAMPLES);
      screen = { color: multisampled.createView(), depth: depth.createView(), resources: [multisampled, depth] };
    }

    function requireShadow(quality, blur) {
      if (!shadow || shadow.quality !== quality) {
        removeTargets(shadow);
        // The blur radius is in CSS pixels. Retina density belongs to the sharp
        // map edges, while the soft shadow can use the same budget on every screen.
        const scale = Math.min((quality === 'lite' ? .26 : .48) / ratio, 750 / Math.max(width, height));
        const size = [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
        const resources = Array.from({ length: 2 }, () => texture(size, 'rgba8unorm', 1, true));
        const [initial, horizontal] = resources.map(target => target.createView());
        const groupFor = (source, buffer) => device.createBindGroup({
          layout: gaussian.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source }, { binding: 1, resource: sampler }, { binding: 2, resource: { buffer } },
          ],
        });
        const composite = device.createBindGroup({
          layout: shadowLayout,
          entries: [{ binding: 0, resource: initial }, { binding: 1, resource: sampler }],
        });
        shadow = {
          resources, quality, size, initial, horizontal, composite,
          blurX: groupFor(initial, kernels[0]), blurY: groupFor(horizontal, kernels[1]),
        };
        previousBlur = NaN;
      }
      if (previousBlur !== blur) {
        device.queue.writeBuffer(kernels[0], 0, kernelUniform(shoreGaussian(shadow.size[0], width / ratio, true, blur)));
        device.queue.writeBuffer(kernels[1], 0, kernelUniform(shoreGaussian(shadow.size[1], height / ratio, false, blur)));
        previousBlur = blur;
      }
    }

    function paint(transform, color, endColor = color, alpha = 1, more = [0, 0, 0]) {
      const offset = paintCount++ * stride;
      const i = offset / 4;
      paintData.set(transform, i);
      paintData.set(color, i + 4);
      paintData[i + 7] = alpha;
      paintData.set(endColor, i + 8);
      paintData[i + 11] = alpha;
      paintData.set(more, i + 12);
      return offset;
    }

    function bind(pass, offset) {
      pass.setBindGroup(0, group, [offset]);
    }

    function bindGeometry(pass) {
      if (geometry.vertices) pass.setVertexBuffer(0, geometry.vertices);
      if (geometry.indices) pass.setIndexBuffer(geometry.indices, geometry.indexFormat);
    }

    function triangles(pass, range, offset) {
      bind(pass, offset);
      if (range.length) pass.drawIndexed(range.length, 1, range.index, range.vertex);
      else pass.draw(range.count, 1, range.vertex);
    }

    function continent(pass, index, offset) {
      const spans = visibleLand[index];
      if (!spans.length) return;
      const range = geometry.continents[index].range;
      bind(pass, offset);
      for (let i = 0; i < spans.length; i += 2) {
        pass.drawIndexed(spans[i + 1], 1, range.index + spans[i], range.vertex);
      }
    }

    function segments(pass, source, offset) {
      if (!source) return;
      bind(pass, offset);
      pass.setVertexBuffer(0, source.buffer);
      pass.draw(6, source.count);
    }

    function blurPass(encoder, target, inputs) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      });
      pass.setPipeline(gaussian);
      pass.setBindGroup(0, inputs);
      pass.draw(3);
      pass.end();
    }

    function shadowPass(encoder, accents, baseShadow, accentShadow) {
      const mask = encoder.beginRenderPass({
        colorAttachments: [{ view: shadow.initial, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      });
      bindGeometry(mask);
      if (baseShadow) {
        mask.setPipeline(shadowLand);
        const solid = paint([0, 0, 1, 0], [1, 0, 0]);
        for (let i = 0; i < geometry.continents.length; i++) continent(mask, i, solid);
        mask.setPipeline(shadowCut);
        for (const { range, cutOpacity } of accents) {
          if (cutOpacity > 0) triangles(mask, range, paint([0, 0, 1, 0], [0, 0, 0], undefined, cutOpacity));
        }
      }
      if (accentShadow) {
        mask.setPipeline(shadowLift);
        for (const { range, transform, opacity, raised } of accents) {
          if (raised) triangles(mask, range, paint(transform, [0, 1, 0], undefined, opacity));
        }
      }
      mask.end();
      if (previousBlur > 0) {
        blurPass(encoder, shadow.horizontal, shadow.blurX);
        blurPass(encoder, shadow.initial, shadow.blurY);
      }
    }

    function draw({ lon, lat, x, y, radius, settings, quality, accents = [] }) {
      if (disposed || !width || radius <= 0) return false;
      try {
        visibleLand = selectLand(lon, lat, x, y, radius, width / ratio, height / ratio);
        if (currentSettings !== settings) {
          const fields = geometry.continents.map(({ field }) => field);
          const names = ['waterLight', 'waterMid', 'waterDark', 'borderColor', 'shoreColor', ...fields];
          palette = Object.fromEntries(names.map(name => [name, rgb(settings[name])]));
          currentSettings = settings;
        }
        const liftedShapes = [];
        for (const { id, offsetX = 0, offsetY = 0, scale = 1, opacity = 1, cutOpacity = opacity, light, dark } of accents) {
          const range = geometry.countries.get(id) ?? geometry.countries.get(String(id));
          if (range && opacity > 0) {
            const raised = Boolean(offsetX || offsetY || scale !== 1);
            liftedShapes.push({ range, transform: [offsetX, offsetY, scale, 0], raised, opacity: clamp01(opacity), cutOpacity: clamp01(cutOpacity), light, dark });
          }
        }
        requirePaints(18 + geometry.continents.length + 4 * liftedShapes.length);
        requireScreen();
        paintCount = 0;

        const cosLon = Math.cos(lon * RAD);
        const sinLon = Math.sin(lon * RAD);
        const cosLat = Math.cos(lat * RAD);
        const sinLat = Math.sin(lat * RAD);
        scene.set([
          -sinLon, cosLon, 0, 0,
          -cosLon * sinLat, -sinLon * sinLat, cosLat, 0,
          cosLon * cosLat, sinLon * cosLat, sinLat, 0,
          width / ratio, height / ratio, x, y, radius, ratio, 0, 0,
        ]);
        const baseShadow = clamp01(settings.shoreOpacity / 100);
        const accentShadow = liftedShapes.some(shape => shape.raised) ? clamp01(settings.hoverShadow / 100) : 0;
        const encoder = device.createCommandEncoder();
        if (baseShadow || accentShadow) {
          requireShadow(quality, settings.shoreBlur);
          shadowPass(encoder, liftedShapes, baseShadow, accentShadow);
        }

        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: screen.color, resolveTarget: context.getCurrentTexture().createView(),
            loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'discard',
          }],
          depthStencilAttachment: {
            view: screen.depth, depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1,
            stencilLoadOp: 'clear', stencilStoreOp: 'discard', stencilClearValue: 0,
          },
        });
        // Only the bottom contact shadow extends below the sphere. Lifted
        // countries can protrude past the limb, so restore the full scissor for land.
        const left = Math.max(0, Math.min(width, Math.floor((x - radius) * ratio) - 2));
        const right = Math.max(left, Math.min(width, Math.ceil((x + radius) * ratio) + 2));
        const top = Math.max(0, Math.min(height, Math.floor((y - radius) * ratio) - 2));
        const reach = Math.max(radius, radius * .984 + Math.max(10, radius * .09));
        const bottom = Math.max(top, Math.min(height, Math.ceil((y + reach) * ratio) + 2));
        pass.setScissorRect(left, top, right - left, bottom - top);
        pass.setPipeline(ocean);
        bind(pass, paint([0, 0, 1, 0], palette.waterLight, palette.waterMid, 1, palette.waterDark));
        pass.draw(3);

        pass.setStencilReference(0);
        if (grid && settings.gridOpacity > 0) {
          pass.setPipeline(lines);
          segments(pass, grid, paint([0, 0, 1, .64], [.196, .361, .427], undefined, settings.gridOpacity * .0065));
        }
        if (baseShadow) {
          pass.setPipeline(coast);
          pass.setBindGroup(1, shadow.composite);
          bind(pass, paint([0, settings.shoreLift, 1, 0], palette.shoreColor, undefined, baseShadow));
          pass.draw(3);
        }

        pass.setScissorRect(0, 0, width, height);
        bindGeometry(pass);
        if (liftedShapes.some(({ cutOpacity }) => cutOpacity > 0)) {
          pass.setPipeline(cutter);
          pass.setStencilReference(1);
          for (const { range, cutOpacity } of liftedShapes) {
            if (cutOpacity > 0) triangles(pass, range, paint([0, 0, 1, 0], [0, 0, 0], undefined, cutOpacity));
          }
        }
        pass.setPipeline(land);
        pass.setStencilReference(0);
        for (let i = 0; i < geometry.continents.length; i++) {
          if (visibleLand[i].length) continent(pass, i, paint([0, 0, 1, 0], palette[geometry.continents[i].field]));
        }
        if (settings.borderWidth > 0 && settings.borderOpacity > 0) {
          pass.setPipeline(lines);
          const stroke = paint([0, 0, 1, settings.borderWidth], palette.borderColor, undefined, settings.borderOpacity / 100);
          segments(pass, borders, stroke);
          segments(pass, detail, stroke);
        }
        if (accentShadow) {
          pass.setPipeline(coast);
          pass.setBindGroup(1, shadow.composite);
          bind(pass, paint([0, 1.25, 1, 0], [.082, .212, .267], undefined, accentShadow * .62, [1, 0, 0]));
          pass.draw(3);
        }
        if (liftedShapes.length) {
          pass.setPipeline(lifted);
          bindGeometry(pass);
          for (const { range, transform, light, dark, opacity } of liftedShapes) triangles(pass, range, paint(transform, light, dark, opacity));
        }
        pass.end();

        device.queue.writeBuffer(sceneBuffer, 0, scene);
        device.queue.writeBuffer(paintBuffer, 0, paintData.subarray(0, paintCount * stride / 4));
        device.queue.submit([encoder.finish()]);
        return true;
      } catch (error) {
        return fail(error);
      }
    }

    ready = true;
    return { resize, draw, setDetail, dispose };
  } catch (error) {
    fail(error);
    return null;
  }
}
