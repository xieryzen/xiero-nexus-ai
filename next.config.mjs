import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Release bundles are built self-contained with NEXT_OUTPUT=standalone
  // (see scripts/package-release.sh). Normal `npm run build` is unchanged.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Build metadata, inlined at build time and shown in the dashboard.
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_SHA: process.env.BUILD_SHA ?? "",
  },
  // Type errors still fail the build; lint is run separately via `npm run lint`.
  eslint: { ignoreDuringBuilds: true },
  // better-sqlite3 is a native module and must not be bundled by Next's server compiler.
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
