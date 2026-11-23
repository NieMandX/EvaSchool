import assert from 'node:assert/strict';
import test from 'node:test';
import { mountTrackpad } from '../src/trackpad.js';

test('desktop scroll, pinch and touchscreen input each have one owner', () => {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const input = new EventTarget();
  let directTouch = false;
  const rotations = [], zooms = [];
  function send(target, type, data = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), data);
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }
  const wheel = (deltaX, deltaY, ctrlKey = false) =>
    send(input, 'wheel', { deltaMode: 0, deltaX, deltaY, ctrlKey, clientX: 40 });
  try {
    const select = mountTrackpad(input, {
      pointFor: event => event.clientX, accepts: point => point > 0,
      directTouch: () => directTouch, begin() {}, end() {},
      rotate: (x, y) => rotations.push([x, y]),
      zoom: (factor, point, direct) => zooms.push({ factor, point, direct }),
    });
    assert.equal(send(input, 'wheel', { clientX: -1 }), false);
    assert.equal(wheel(12, -9), true);
    assert.deepEqual(rotations, [[12, -9]]);
    assert.equal(zooms.length, 0);
    wheel(0, -100 * Math.log(1.25), true);
    assert.deepEqual(zooms.pop(), { factor: 1.25, point: 40, direct: true });

    send(input, 'gesturestart', { clientX: 40, scale: 1 });
    send(window, 'gesturechange', { scale: 1.3 });
    wheel(0, -100 * Math.log(1.3), true);
    send(window, 'gesturechange', { scale: 1.5 });
    send(window, 'gestureend', { scale: 1.5 });
    assert.equal(zooms.length, 3);
    assert.ok(Math.abs(zooms.reduce((scale, item) => scale * item.factor, 1) - 1.5) < 1e-8);

    select('mouse');
    wheel(0, -50);
    assert.equal(zooms.at(-1).direct, false);
    assert.ok(zooms.at(-1).factor > 1);
    directTouch = true;
    assert.equal(wheel(0, -25, true), false);
    assert.equal(send(input, 'gesturestart', { clientX: 40 }), false);
  } finally {
    send(window, 'blur');
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
