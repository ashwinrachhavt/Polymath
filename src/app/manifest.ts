import type { MetadataRoute } from "next";

/*
 * What "Add to Home Screen" reads: a standalone app (no browser chrome), the
 * default graphite accent as its theme colour, and icons from public/icons.
 * The maskable icon has its mark inside the safe zone so Android can crop it
 * to any shape. There is no service worker: the app needs the network for its
 * data, and a stale offline shell of an authenticated app is a worse failure
 * than a loading screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Polymath",
    short_name: "Polymath",
    description: "Personal command center and knowledge operating system.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#202226",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
