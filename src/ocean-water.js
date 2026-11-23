// Cells intersected by map edges always go through the exact spherical picker.
export const WATER_COLUMNS = 1440;
export const WATER_ROWS = WATER_COLUMNS / 2;
export const WATER = 1;
export const LAND = 2;
export const EDGE = 3;

export function createWaterLookup(encoded, countryAtCoordinates) {
  const cells = new Uint8Array(WATER_COLUMNS * WATER_ROWS / 4);
  const runs = atob(encoded);
  let offset = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs.charCodeAt(i);
    const end = offset + (run >> 2) + 1;
    const material = run & 3;
    for (; offset < end; offset++) cells[offset >> 2] |= material << ((offset & 3) * 2);
  }
  return coordinates => {
    const [lon, lat] = coordinates;
    const x = Math.min(WATER_COLUMNS - 1, Math.floor((lon + 180) * WATER_COLUMNS / 360));
    const y = Math.min(WATER_ROWS - 1, Math.floor((lat + 90) * WATER_ROWS / 180));
    const index = y * WATER_COLUMNS + x;
    const cell = (cells[index >> 2] >> ((index & 3) * 2)) & 3;
    return cell === WATER || (cell === EDGE && !countryAtCoordinates(coordinates));
  };
}
