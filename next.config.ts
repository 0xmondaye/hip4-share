import type { NextConfig } from "next"
import path from "node:path"

const projectRoot = path.resolve(__dirname)

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  outputFileTracingRoot: projectRoot,
  // Privy's embedded-wallet iframe (custom auth domain privy.hip4.gambitapp.io)
  // only serves the canonical domain. On any other host — notably the old
  // hip4-frontend.vercel.app links — every wallet signature fails with
  // "Failed to sign the typed data using the wallet", so users can deposit
  // but never sign (trade, transfer, withdraw). Force the canonical host.
  // The 3D pack's MESH only. Every print on it is ours (public/pack-art), so
  // this is geometry, not art — narrowed from a `:path*` wildcard to the one
  // file so their CDN can't serve a texture through us again by accident. Their
  // CDN sends no CORS headers, hence the same-origin proxy.
  async rewrites() {
    return [
      { source: "/pack-mesh/skeleton.glb", destination: "https://slabz.com/packs/glb/skeleton.glb" },
    ]
  },
  async redirects() {
    return [
      // wine moved under the gacha section (one shop, one collection)
      { source: "/wine", destination: "/gacha/wine", permanent: false },
      {
        source: "/:path*",
        has: [{ type: "host", value: "hip4-frontend.vercel.app" }],
        destination: "https://hip4.gambitapp.io/:path*",
        permanent: false,
      },
    ]
  },
  // local.hip4.gambitapp.io — see the dev:https script. Privy's custom auth
  // domain (privy.hip4.gambitapp.io) scopes privy-token/privy-id-token to
  // Domain=hip4.gambitapp.io, so a localhost origin can never hold a session:
  // every gated route 401s and Privy force-logs-out on reload. Must be a
  // subdomain OF hip4.gambitapp.io — local.gambitapp.io is a sibling of hip4
  // and receives nothing.
  allowedDevOrigins: ["192.168.50.33", "local.hip4.gambitapp.io"],
}

export default nextConfig
