export function shoreGaussian(maskSize, cssSize, horizontal, blur) {
  const sigma = blur > 0 ? Math.max(.25, Math.min(8, blur * .5 * maskSize / cssSize)) : 0;
  const radius = Math.ceil(sigma * 3);
  const weight = distance => Math.exp(-.5 * (distance / sigma) ** 2);
  const pairs = new Float32Array(24);
  let sum = 1;
  // Linear filtering folds each set of neighboring taps into one texture read.
  for (let i = 1; i <= radius; i += 2) {
    const first = weight(i);
    const second = i < radius ? weight(i + 1) : 0;
    pairs[i - 1] = i + second / (first + second);
    pairs[i] = first + second;
    sum += 2 * (first + second);
  }
  for (let i = 1; i < pairs.length; i += 2) pairs[i] /= sum;
  const step = 1 / maskSize;
  return { pairs, stepX: horizontal ? step : 0, stepY: horizontal ? 0 : step, center: 1 / sum, count: Math.ceil(radius / 2) };
}
