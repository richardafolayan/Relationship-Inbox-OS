import type { MetadataRoute } from "next";
// Relative import so tests can load this module via tsx without Next path aliases.
import { APP_NAME } from "../lib/branding";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: APP_NAME,
    short_name: APP_NAME,
    description: "A private inbox for unfinished conversations",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    background_color: "#f7f2e8",
    theme_color: "#f7f2e8",
    icons: [
      {
        src: "/icons/tovi-192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "/icons/tovi-512.png",
        sizes: "512x512",
        type: "image/png"
      },
      {
        src: "/icons/tovi-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  };
}
