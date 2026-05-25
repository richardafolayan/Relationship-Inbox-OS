import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { FullDemoProvider } from "@/components/full-demo/FullDemoProvider";
import { FullDemoOverlay } from "@/components/full-demo/FullDemoOverlay";

export const metadata: Metadata = {
  title: "Relationship Inbox OS",
  description: "Local-first command centre for relationship replies"
};

// Runs before paint to apply the persisted theme and avoid a flash of
// the wrong palette. Falls back to the OS preference on first load.
const themeBootstrap = `(function(){try{var s=localStorage.getItem('inbox_os_theme');var t=s||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <FullDemoProvider>
          <AppShell>{children}</AppShell>
          <FullDemoOverlay />
        </FullDemoProvider>
      </body>
    </html>
  );
}
