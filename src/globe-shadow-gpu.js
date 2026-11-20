import { defaultShadowColor, shoreGaussian } from './globe-shadow-kernel.js';

const SHADER = /* wgsl */ `
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Vertex(vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), uv);
}

struct Kernel { step: vec2f, count: f32, center: f32, pairs: array<vec4f, 12> }
struct Composite {
  viewport: vec2f, center: vec2f, radius: f32, ratio: f32, cut: f32, lift: f32, color: vec4f,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var<uniform> kernel: Kernel;
@group(0) @binding(3) var cutMask: texture_2d<f32>;
@group(0) @binding(4) var<uniform> scene: Composite;

@fragment fn blur(@location(0) uv: vec2f) -> @location(0) vec4f {
  // The first pass receives a Canvas2D alpha mask. The second reads red from r8unorm.
  let channel = select(3, 0, kernel.step.y > 0.0);
  var coverage = textureSampleLevel(source, linear, uv, 0.0)[channel] * kernel.center;
  for (var i = 0; i < i32(kernel.count); i++) {
    let pair = kernel.pairs[i];
    let delta = kernel.step * pair.x;
    coverage += pair.y * (textureSampleLevel(source, linear, uv + delta, 0.0)[channel]
                        + textureSampleLevel(source, linear, uv - delta, 0.0)[channel]);
  }
  return vec4f(coverage, 0.0, 0.0, 1.0);
}

@fragment fn shore(@location(0) uv: vec2f) -> @location(0) vec4f {
  let circle = clamp((scene.radius - distance(uv * scene.viewport, scene.center)) * scene.ratio + 0.5, 0.0, 1.0);
  let dy = vec2f(0.0, scene.lift / scene.viewport.y);
  var alpha = textureSampleLevel(source, linear, uv - dy, 0.0).r * circle * scene.color.a;
  if (scene.cut > 0.0) { alpha *= 1.0 - textureSampleLevel(cutMask, linear, uv, 0.0).a; }
  return vec4f(scene.color.rgb * alpha, alpha);
}
`;

function packKernel({ stepX, stepY, center, count, pairs }) {
  // Uniform array elements must each occupy a 16-byte row in WGSL.
  const weights = new Float32Array(4 + 12 * 4);
  weights.set([stepX, stepY, count, center]);
  for (let i = 0; i < count; i++) {
    weights[4 + i * 4] = pairs[i * 2];
    weights[5 + i * 4] = pairs[i * 2 + 1];
  }
  return weights;
}

export async function createGpuShoreShadow(canvas, onFailure) {
  const gpu = navigator.gpu;
  if (!gpu) return null;
  let device, context, textures, uniforms;
  let disposed = false;
  let ready = false;
  let width = 0, height = 0, ratio = 1;
  let cached = false;
  let kernelBlur;

  function dispose() {
    if (disposed) return;
    disposed = true;
    context?.unconfigure();
    textures?.forEach(texture => texture.destroy());
    uniforms?.forEach(buffer => buffer.destroy());
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
    const module = device.createShaderModule({ code: SHADER });
    const pipeline = (entryPoint, target) => device.createRenderPipelineAsync({
      layout: 'auto', vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint, targets: [{ format: target }] },
    });
    const [blurPass, composite] = await Promise.all([pipeline('blur', 'r8unorm'), pipeline('shore', format)]);
    if (disposed) return null;
    device.pushErrorScope('validation');
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    uniforms = [208, 208, 48].map(size => device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    context.configure({ device, format, alphaMode: 'premultiplied' });
    const configurationError = await device.popErrorScope();
    if (configurationError || disposed) {
      dispose();
      return null;
    }

    let source, horizontal, vertical, aperture;
    let horizontalGroup, verticalGroup, openGroup, cutGroup;
    let horizontalView, verticalView;
    const bindings = (target, view, entries) => device.createBindGroup({
      layout: target.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }, ...entries],
    });
    const uniform = (binding, buffer) => ({ binding, resource: { buffer } });
    const upload = (mask, texture) => device.queue.copyExternalImageToTexture(
      { source: mask }, { texture }, [mask.width, mask.height]);

    function pass(encoder, target, bindGroup, view) {
      const commands = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      });
      commands.setPipeline(target);
      commands.setBindGroup(0, bindGroup);
      commands.draw(3);
      commands.end();
    }

    function allocate(mask) {
      textures?.forEach(texture => texture.destroy());
      cached = false;
      const size = [mask.width, mask.height];
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
      const target = format => device.createTexture({ size, format, usage: usage | GPUTextureUsage.COPY_DST });
      textures = [source, horizontal, vertical, aperture] = [
        target('rgba8unorm'), target('r8unorm'), target('r8unorm'), target('rgba8unorm'),
      ];
      const sourceView = source.createView();
      horizontalView = horizontal.createView();
      verticalView = vertical.createView();
      horizontalGroup = bindings(blurPass, sourceView, [uniform(2, uniforms[0])]);
      verticalGroup = bindings(blurPass, horizontalView, [uniform(2, uniforms[1])]);
      openGroup = bindings(composite, verticalView, [{ binding: 3, resource: sourceView }, uniform(4, uniforms[2])]);
      cutGroup = bindings(composite, verticalView, [{ binding: 3, resource: aperture.createView() }, uniform(4, uniforms[2])]);
    }

    function resize(nextWidth, nextHeight, nextRatio) {
      if (disposed) return false;
      if (nextWidth === width && nextHeight === height && nextRatio === ratio) return true;
      if (nextWidth < 1 || nextHeight < 1 || nextRatio <= 0 ||
          Math.max(nextWidth, nextHeight) > device.limits.maxTextureDimension2D) return fail();
      canvas.width = width = nextWidth;
      canvas.height = height = nextHeight;
      ratio = nextRatio;
      cached = false;
      return true;
    }

    const scene = new Float32Array(12);
    function draw({ landMask, cutMask, x, y, radius, lift = 3, blur = 8, color = defaultShadowColor }) {
      if (disposed || !width || (!landMask && !cached)) return false;
      try {
        const encoder = device.createCommandEncoder();
        if (landMask) {
          if (!source || source.width !== landMask.width || source.height !== landMask.height) allocate(landMask);
          upload(landMask, source);
        }
        const kernelChanged = !cached || kernelBlur !== blur;
        if (kernelChanged) {
          device.queue.writeBuffer(uniforms[0], 0, packKernel(shoreGaussian(source.width, width / ratio, true, blur)));
          device.queue.writeBuffer(uniforms[1], 0, packKernel(shoreGaussian(source.height, height / ratio, false, blur)));
          kernelBlur = blur;
        }
        if (landMask || kernelChanged) {
          pass(encoder, blurPass, horizontalGroup, horizontalView);
          pass(encoder, blurPass, verticalGroup, verticalView);
        }
        if (cutMask) upload(cutMask, aperture);
        scene.set([width / ratio, height / ratio, x, y, radius, ratio, cutMask ? 1 : 0, lift]);
        scene.set(color, 8);
        device.queue.writeBuffer(uniforms[2], 0, scene);
        pass(encoder, composite, cutMask ? cutGroup : openGroup, context.getCurrentTexture().createView());
        device.queue.submit([encoder.finish()]);
        cached = true;
        return true;
      } catch (error) {
        return fail(error);
      }
    }

    ready = true;
    return { resize, draw, dispose };
  } catch (error) {
    fail(error);
    return null;
  }
}
