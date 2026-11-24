import type { MetadataRoute } from "next";

/**
 * What a phone needs to put the app on its home screen and open it without
 * the bars of a browser: a name, where it starts, its colours and its icon.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Xiero Nexus AI",
    short_name: "Nexus",
    description: "An assistant that acts, with the models of your own providers.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#151515",
    theme_color: "#151515",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
