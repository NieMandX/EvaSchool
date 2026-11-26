// The same studio light illuminates both materials. Normals are in view space:
// x points right, y up, z toward the viewer. The expression is shared by GLSL and WGSL.
export function globeMaterial(language) {
  const gl = language === 'glsl';
  const scalar = gl ? 'float' : 'let';
  const pair = gl ? 'vec2' : 'let';
  const color = gl ? 'vec3' : 'let';
  return `
    ${gl ? 'vec2 studioLight(vec3 n)' : 'fn studioLight(n: vec3f) -> vec2f'} {
      ${scalar} daylight = clamp(0.36 + 0.64 * dot(n, vec3(-0.46, 0.54, 0.705)), 0.0, 1.0);
      // Orthographic view direction is +z. Intersect its mirror direction with
      // two studio strip lights using their tangent frames (no environment map).
      ${color} ray = (2.0 * n.z) * n - vec3(0.0, 0.0, 1.0);
      ${scalar} facing = dot(ray, vec3(-0.646, 0.725, 0.241));
      ${scalar} along = abs(dot(ray, vec3(0.757, 0.648, 0.081)));
      ${scalar} across = abs(dot(ray, vec3(-0.098, 0.235, -0.967)));
      ${scalar} panel = min(1.04 * facing - along, 0.24 * facing - across);
      ${scalar} key = smoothstep(-0.16, 0.095, panel) * max(0.0, facing);
      ${scalar} side = 0.879 * ray.x - 0.477 * ray.z;
      ${scalar} strip = 0.14 * side - abs(0.477 * ray.x + 0.879 * ray.z);
      ${scalar} fill = smoothstep(-0.13, 0.085, strip) * max(0.0, side - abs(ray.y + 0.08));
      return vec2(daylight, key + 0.68 * fill);
    }
    ${gl ? 'vec3 porcelain(vec3 base, vec3 n, float raised)' : 'fn porcelain(base: vec3f, n: vec3f, raised: f32) -> vec3f'} {
      ${pair} light = studioLight(n);
      ${color} diffuse = base * mix(vec3(0.79, 0.815, 0.845), vec3(0.935), light.x);
      return mix(diffuse, vec3(1.0, 0.998, 0.99), (0.87 + 0.10 * raised) * light.y);
    }
    ${gl ? 'vec3 enamel(vec3 low, vec3 mid, vec3 high, vec3 n)' : 'fn enamel(low: vec3f, mid: vec3f, high: vec3f, n: vec3f) -> vec3f'} {
      ${pair} light = studioLight(n);
      ${color} diffuse = mix(mix(low, mid, min(1.0, 2.0 * light.x)), high, max(0.0, 2.0 * light.x - 1.0));
      ${scalar} grazing = 1.0 - n.z;
      return mix(diffuse, vec3(0.965, 0.985, 1.0), 0.75 * light.y + 0.10 * grazing * grazing);
    }
  `;
}
