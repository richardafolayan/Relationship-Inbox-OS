import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { FullDemoProvider } from "@/components/full-demo/FullDemoProvider";
import { FullDemoOverlay } from "@/components/full-demo/FullDemoOverlay";
import { UiScaleBridge } from "@/components/common/ui-scale-bridge";

export const metadata: Metadata = {
  title: "Tovi",
  description: "Local-first command centre for relationship replies"
};

// viewportFit: "cover" lets the phone layout extend under the iOS home
// indicator; the mobile dock + composer pad themselves back out with
// env(safe-area-inset-bottom), which is zero everywhere else.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

// Runs before paint to apply the persisted theme and avoid a flash of
// the wrong palette. Falls back to the OS preference on first load.
const themeBootstrap = `(function(){try{var s=localStorage.getItem('inbox_os_theme');var t=s||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');var z=localStorage.getItem('inbox_os_ui_scale');if(z==='large'||z==='extra')document.documentElement.setAttribute('data-ui-scale',z);}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <FullDemoProvider>
          <UiScaleBridge />
          <AppShell>{children}</AppShell>
          <FullDemoOverlay />
        </FullDemoProvider>
      </body>
    </html>
  );
}
