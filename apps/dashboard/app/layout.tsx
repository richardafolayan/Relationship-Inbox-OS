import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { FullDemoProvider } from "@/components/full-demo/FullDemoProvider";
import { FullDemoOverlay } from "@/components/full-demo/FullDemoOverlay";
import { UiScaleBridge } from "@/components/common/ui-scale-bridge";
import { APP_NAME } from "@/lib/branding";

export const metadata: Metadata = {
  title: APP_NAME,
  applicationName: APP_NAME,
  description: "A private inbox for unfinished conversations",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/tovi-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/tovi-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: [{ url: "/icons/tovi-180.png", sizes: "180x180", type: "image/png" }]
  },
  appleWebApp: {
    capable: true,
    title: APP_NAME,
    // "default" keeps the status bar opaque so TopStatus and page
    // chrome sit below the notch / Dynamic Island. Do not switch to
    // black-translucent until the shell owns env(safe-area-inset-top).
    statusBarStyle: "default"
  },
  formatDetection: {
    telephone: false
  }
};

// viewportFit: "cover" lets the phone layout extend under the iOS home
// indicator; the mobile dock + composer pad themselves back out with
// env(safe-area-inset-bottom), which is zero everywhere else.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f2e8" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" }
  ]
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
