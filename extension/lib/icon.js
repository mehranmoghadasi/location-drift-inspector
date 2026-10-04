/**
 * icon.js — the toolbar icon, drawn from geometry instead of shipped as PNG files.
 *
 * renderIcon(size) returns RGBA pixels (Uint8ClampedArray, length size*size*4) for a
 * rounded graphite square with a map pin whose head is split into two halves: the
 * profile (left) and the page (right). Pure math with 4×4 supersampling, so the result is
 * identical in the service worker (chrome.action.setIcon({imageData})) and in Node
 * (scripts/package-extension.mjs writes PNGs for a Chrome Web Store upload).
 */

const BG = [29, 36, 51];
const LEFT = [60, 207, 145];
const RIGHT = [242, 180, 65];
const HOLE = [29, 36, 51];

function insideRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insidePin(x, y) {
  const cx = 0.5;
  const cy = 0.42;
  const r = 0.25;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  // Tapered tail from the circle's tangent points down to the tip.
  const tipY = 0.86;
  if (y < cy || y > tipY) return false;
  const half = r * 0.92 * (1 - (y - cy) / (tipY - cy));
  return Math.abs(x - cx) <= half;
}

/** Colour of one sample point in unit coordinates, or null for transparent. */
function sample(x, y) {
  if (!insideRoundedSquare(x, y, 0.22)) return null;
  if (insidePin(x, y)) {
    if ((x - 0.5) ** 2 + (y - 0.42) ** 2 <= 0.095 ** 2) return HOLE;
    return x < 0.5 ? LEFT : RIGHT;
  }
  return BG;
}

/**
 * @param {number} size pixel width and height
 * @returns {Uint8ClampedArray}
 */
export function renderIcon(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const N = 4;
  for (let py = 0; py < size; py += 1) {
    for (let pxi = 0; pxi < size; pxi += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < N; sy += 1) {
        for (let sx = 0; sx < N; sx += 1) {
          const c = sample((pxi + (sx + 0.5) / N) / size, (py + (sy + 0.5) / N) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + pxi) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round((255 * a) / (N * N));
      }
    }
  }
  return px;
}

export const ICON_SIZES = [16, 32, 48, 128];
