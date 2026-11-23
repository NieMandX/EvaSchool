import { loadGlobeMesh } from 'globe-mesh';
import { createWebGlGlobe } from './globe-webgl.js';
import { createWebGpuGlobe } from './globe-webgpu.js';

const factories = { webgpu: createWebGpuGlobe, webgl: createWebGlGlobe };

export function createGlobeRenderer(container, onChange) {
  let active = null;
  let preference = 'auto';
  let generation = 0;
  let pending = false;
  let status = 'loading';
  let cancelRestore = null;

  function report(name) {
    if (name === status) return;
    status = name;
    onChange(name);
  }

  function show(next) {
    const previous = active;
    active = next;
    previous?.surface.remove();
    previous?.driver.dispose();
    if (active) {
      container.append(active.surface);
      report(active.name);
    }
  }

  function waitForWebGl(surface, currentGeneration) {
    active = null;
    pending = true;
    report('loading');
    function cleanUp() {
      clearTimeout(timeout);
      surface.removeEventListener('webglcontextrestored', restored);
      surface.remove();
      cancelRestore = null;
    }
    function restored() {
      cleanUp();
      void probe(['webgl'], currentGeneration, surface);
    }
    // Some drivers never signal restoration. Try a fresh context once in that case.
    const timeout = setTimeout(() => {
      cleanUp();
      void probe(['webgl'], currentGeneration);
    }, 2000);
    surface.addEventListener('webglcontextrestored', restored);
    cancelRestore = cleanUp;
  }

  async function probe(order, generationAtStart, restoredSurface) {
    const [name, ...fallback] = order;
    if (generationAtStart !== generation) return;
    pending = Boolean(name);
    if (!name) {
      report('unavailable');
      return;
    }
    const surface = restoredSurface ?? document.createElement('canvas');
    surface.setAttribute('aria-hidden', 'true');
    let failed = false;
    const candidate = {
      name, surface, driver: null,
      fail(reason) {
        failed = true;
        if (active !== candidate) return;
        if (name === 'webgl' && reason?.type === 'webglcontextlost') {
          waitForWebGl(surface, generationAtStart);
          return;
        }
        show(null);
        report('loading');
        void probe(fallback, generationAtStart);
      },
    };
    try {
      candidate.driver = await factories[name](surface, loadGlobeMesh(), candidate.fail);
    } catch {
      // Context creation can throw on browsers that block graphics acceleration.
      failed = true;
    }
    if (generationAtStart !== generation || failed) {
      candidate.driver?.dispose();
      if (generationAtStart === generation) void probe(fallback, generationAtStart);
    } else if (candidate.driver) {
      pending = false;
      show(candidate);
    } else {
      void probe(fallback, generationAtStart);
    }
  }

  return {
    get active() { return active; },
    get preference() { return preference; },
    get pending() { return pending; },
    select(mode) {
      preference = mode === 'webgl' || mode === 'webgpu' ? mode : 'auto';
      const order = preference === 'webgl' ? ['webgl'] : ['webgpu', 'webgl'];
      const nextGeneration = ++generation;
      cancelRestore?.();
      pending = true;
      show(null);
      report('loading');
      void probe(order, nextGeneration);
    },
  };
}
