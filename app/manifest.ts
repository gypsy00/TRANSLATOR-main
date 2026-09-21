import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Verba",
    short_name: "Verba",
    description: "Live sermon translation — listeners read in their own language",
    start_url: "/listen",
    display: "standalone",
    background_color: "#030712",
    theme_color: "#030712",
    icons: [
      {
        // A single scalable icon, so there are no missing PNGs to 404 on.
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
