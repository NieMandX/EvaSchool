const RAD = Math.PI / 180;
const PIXEL_MARGIN = 6;

// A box containing three triangle vertices also contains every point between them.
// Return visible spans in the same index units for the color and shadow passes.
export function createLandVisibility(continents) {
  const ranges = continents.map(() => []);
  let lastLon, lastLat, lastX, lastY, lastRadius, lastWidth, lastHeight;
  return (lon, lat, x, y, radius, width, height) => {
    if (lon === lastLon && lat === lastLat && x === lastX && y === lastY && radius === lastRadius
      && width === lastWidth && height === lastHeight) return ranges;
    lastLon = lon;
    lastLat = lat;
    lastX = x;
    lastY = y;
    lastRadius = radius;
    lastWidth = width;
    lastHeight = height;
    const cosLon = Math.cos(lon * RAD);
    const sinLon = Math.sin(lon * RAD);
    const cosLat = Math.cos(lat * RAD);
    const sinLat = Math.sin(lat * RAD);
    const absCosLon = Math.abs(cosLon), absSinLon = Math.abs(sinLon);
    const absCosLat = Math.abs(cosLat), absSinLat = Math.abs(sinLat);
    const left = (-x - PIXEL_MARGIN) / radius;
    const right = (width - x + PIXEL_MARGIN) / radius;
    const bottom = (y - height - PIXEL_MARGIN) / radius;
    const top = (y + PIXEL_MARGIN) / radius;
    for (let i = 0; i < continents.length; i++) {
      const spans = ranges[i];
      let count = 0;
      let first = 0;
      let pending = -1;
      for (const [end, cx, cy, cz, hx, hy, hz] of continents[i].batches) {
        const horizontal = cosLon * cx + sinLon * cy;
        const front = cosLat * horizontal + sinLat * cz;
        const east = cosLon * cy - sinLon * cx;
        const north = cosLat * cz - sinLat * horizontal;
        const horizontalHalf = absCosLon * hx + absSinLon * hy;
        const frontHalf = absCosLat * horizontalHalf + absSinLat * hz;
        const eastHalf = absSinLon * hx + absCosLon * hy;
        const northHalf = absSinLat * horizontalHalf + absCosLat * hz;
        const visible = front + frontHalf >= 0 && east + eastHalf >= left && east - eastHalf <= right
          && north + northHalf >= bottom && north - northHalf <= top;
        if (visible && pending < 0) pending = first;
        if (!visible && pending >= 0) {
          spans[count++] = pending;
          spans[count++] = first - pending;
          pending = -1;
        }
        first = end;
      }
      if (pending >= 0) {
        spans[count++] = pending;
        spans[count++] = first - pending;
      }
      spans.length = count;
    }
    return ranges;
  };
}
