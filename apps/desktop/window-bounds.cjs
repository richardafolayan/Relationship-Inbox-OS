function intersectionArea(bounds, area) {
  const width = Math.max(
    0,
    Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  );
  const height = Math.max(
    0,
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  );
  return width * height;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveWindowBounds(saved, displays, fallback = { width: 1280, height: 820 }) {
  const areas = displays.map((display) => display.workArea).filter(Boolean);
  const primary = displays.find((display) => display.primary)?.workArea ?? areas[0];
  if (!primary) return { width: fallback.width, height: fallback.height };
  const valid =
    saved &&
    [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) &&
    saved.width > 0 &&
    saved.height > 0;
  const target = valid
    ? areas
        .map((area) => ({ area, overlap: intersectionArea(saved, area) }))
        .sort((left, right) => right.overlap - left.overlap)[0]
    : null;
  if (target && target.overlap >= 80 * 80) {
    const width = Math.min(saved.width, target.area.width);
    const height = Math.min(saved.height, target.area.height);
    return {
      width,
      height,
      x: clamp(saved.x, target.area.x, target.area.x + target.area.width - width),
      y: clamp(saved.y, target.area.y, target.area.y + target.area.height - height)
    };
  }
  const width = Math.min(fallback.width, primary.width);
  const height = Math.min(fallback.height, primary.height);
  return {
    width,
    height,
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + Math.round((primary.height - height) / 2)
  };
}

module.exports = { resolveWindowBounds };
