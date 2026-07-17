export type AppleStatusBarStyle = "default" | "black" | "black-translucent";
export type AppTheme = "light" | "dark";

// Opaque styles only. Translucent status bars draw content under the notch
// and need shell-owned safe-area-inset-top before they are safe to use.
export function appleStatusBarStyleForTheme(theme: AppTheme): AppleStatusBarStyle {
  return theme === "dark" ? "black" : "default";
}

export function themeColorForTheme(theme: AppTheme): string {
  return theme === "dark" ? "#000000" : "#f7f2e8";
}

export function applyAppleStatusBarStyle(
  style: AppleStatusBarStyle,
  doc: Document = document
): void {
  let meta = doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (!meta) {
    meta = doc.createElement("meta");
    meta.setAttribute("name", "apple-mobile-web-app-status-bar-style");
    doc.head.appendChild(meta);
  }
  meta.setAttribute("content", style);
}

export function applyThemeColor(color: string, doc: Document = document): void {
  const metas = Array.from(doc.querySelectorAll('meta[name="theme-color"]'));
  if (metas.length === 0) {
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", color);
    doc.head.appendChild(meta);
    return;
  }
  for (const meta of metas) {
    meta.setAttribute("content", color);
  }
}

export function applyAppleChromeForTheme(
  theme: AppTheme,
  doc: Document = document
): void {
  applyAppleStatusBarStyle(appleStatusBarStyleForTheme(theme), doc);
  applyThemeColor(themeColorForTheme(theme), doc);
}
