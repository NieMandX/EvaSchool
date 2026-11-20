import { createGlShoreShadow } from './globe-shadow-gl.js';
import { createGpuShoreShadow } from './globe-shadow-gpu.js';

const factories = { webgpu: createGpuShoreShadow, webgl: createGlShoreShadow };

export function createGlobeRenderer(anchor, onChange) {
  let active = null;
  let preference = 'auto';
  let generation = 0;

  function show(next) {
    if (active === next) return;
    const previous = active;
    active = next;
    previous?.surface.remove();
    previous?.driver.dispose();
    if (active) anchor.after(active.surface);
    onChange(active?.name ?? 'canvas');
  }

  async function probe(order, generationAtStart) {
    const [name, ...fallback] = order;
    if (!name || generationAtStart !== generation) return;
    const surface = document.createElement('canvas');
    surface.setAttribute('aria-hidden', 'true');
    let failed = false;
    const candidate = { name, surface, driver: null, fail() {
      failed = true;
      if (active !== candidate) return;
      show(null);
      void probe(fallback, generationAtStart);
    } };
    try {
      candidate.driver = await factories[name](surface, candidate.fail);
    } catch {
      // Context creation can throw on browsers that block graphics acceleration.
      failed = true;
    }
    if (generationAtStart !== generation || failed) {
      candidate.driver?.dispose();
      if (generationAtStart === generation) void probe(fallback, generationAtStart);
    } else if (candidate.driver) {
      show(candidate);
    } else {
      void probe(fallback, generationAtStart);
    }
  }

  return {
    get active() { return active; },
    get preference() { return preference; },
    select(mode) {
      preference = ['canvas', 'webgl', 'webgpu'].includes(mode) ? mode : 'auto';
      const order = preference === 'canvas' ? [] : preference === 'webgl' ? ['webgl'] : ['webgpu', 'webgl'];
      const nextGeneration = ++generation;
      show(null);
      void probe(order, nextGeneration);
    },
  };
}
