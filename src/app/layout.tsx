import type { Metadata } from "next"
import { Analytics } from "@vercel/analytics/next"
import { GeistPixelCircle } from "geist/font/pixel"
import { Bricolage_Grotesque, Geist_Mono } from "next/font/google"
import { Providers } from "@/components/Providers"
import { HeaderBrand } from "@/components/HeaderBrand"
import { AuthMenu } from "@/components/AuthMenu"
import { BottomNav, DesktopNav } from "@/components/BottomNav"
import { PwaInstallCoach } from "@/components/PwaInstallCoach"
import { ScrollHeader } from "@/components/ScrollHeader"
import { RouteProgress } from "@/components/RouteProgress"
import "./globals.css"

const sans = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  // variable font: wght comes free, opsz has to be asked for
  axes: ["opsz"],
})
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Speculate — Hyperliquid Outcome Markets",
  authors: [{ name: "6ren.studio", url: "https://6ren.studio" }],
  description:
    "Trade real-world outcomes on Hyperliquid. Onchain prediction markets, zero fees to open, fully collateralized.",
  // makes iOS "Add to Home Screen" launch standalone instead of a Safari bookmark
  appleWebApp: {
    capable: true,
    title: "Speculate",
    statusBarStyle: "black-translucent",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${geistMono.variable} ${GeistPixelCircle.variable} dark h-full antialiased`}
    >
      <head>
        {/* Keep raw HTML off the head itself: React recovery must preserve CSS links. */}
        <template
          dangerouslySetInnerHTML={{
            __html: `<!--

   ▄▄▄                                       ▄               █    ▀
 ▄▀   ▀  ▄ ▄▄   ▄▄▄   ▄ ▄▄           ▄▄▄   ▄▄█▄▄  ▄   ▄   ▄▄▄█  ▄▄▄     ▄▄▄
 █▄▀▀█▄  █▀  ▀ █▀  █  █▀  █         █   ▀    █    █   █  █▀ ▀█    █    █▀ ▀█
 █    █  █     █▀▀▀▀  █   █          ▀▀▀▄    █    █   █  █   █    █    █   █
  █▄▄█▀  █     ▀█▄▄▀  █   █    █    ▀▄▄▄▀    ▀▄▄  ▀▄▄▀█  ▀█▄██  ▄▄█▄▄  ▀█▄█▀


Meticulously crafted by https://6ren.studio
-->
`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Providers>
          <RouteProgress />
          <ScrollHeader>
            <div className="mx-auto w-full container px-3 lg:px-0 py-3 flex items-center justify-between">
              <div className="flex items-center lg:gap-8">
                <HeaderBrand />
                <DesktopNav />
              </div>
              <AuthMenu />
            </div>
          </ScrollHeader>
          <main className="flex-1 mx-auto w-full container px-3 lg:px-0 pt-4 sm:pt-8 pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-8">
            {children}
          </main>
          <footer className="hidden lg:block border-t border-border text-xs text-muted-foreground">
            <div className="mx-auto w-full container px-3 lg:px-0 py-4 flex items-center justify-between flex-wrap gap-2">
              <span>
                Data from{" "}
                <a
                  href="https://api.hyperliquid.xyz"
                  className="hover:text-foreground"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  api.hyperliquid.xyz
                </a>
              </span>
              <span>HIP-4 · fully collateralized · zero fee to open</span>
            </div>
          </footer>
          <BottomNav />
          <PwaInstallCoach />
        </Providers>
        <Analytics />
      </body>
    </html>
  )
}
