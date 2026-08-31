const BROWSER_IMPORT_PATTERN =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:@playwright\/test|electron|patchright|playwright|puppeteer)["']/;
const BROWSER_MARKER_PATTERN = /(?:^|\n)\s*\/\/\s*@tovi-browser\b/;
const PLATFORM_MARKER_PATTERN =
  /(?:^|\n)\s*\/\/\s*@tovi-browser-platform\s+([^\n]+)/;
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);

export function classifyBrowserFixture(source, platform) {
  const browser = BROWSER_MARKER_PATTERN.test(source) || BROWSER_IMPORT_PATTERN.test(source);
  if (!browser) return { browser: false, applicable: true };

  const marker = source.match(PLATFORM_MARKER_PATTERN)?.[1];
  if (!marker) return { browser: true, applicable: true };

  const platforms = marker
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of platforms) {
    if (!SUPPORTED_PLATFORMS.has(value)) {
      throw new Error(`Unknown @tovi-browser-platform value ${value}`);
    }
  }
  return { browser: true, applicable: platforms.includes(platform) };
}
