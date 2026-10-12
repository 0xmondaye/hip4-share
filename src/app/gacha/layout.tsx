// Section chrome for every gacha route: the pack-wallet auto-sweeper, so
// resting USDC — a sellback whose bridge stalled, an interrupted pull — comes
// home without the user finding a button.
//
// The Packs/Cellar/Collection tab row is gone: the stage is the storefront now,
// the Cellar is a universe in its picker rail, and Collection is a link at the
// foot of that rail. A tab bar over a full-bleed rip stage is chrome for three
// destinations the stage already reaches.

import { RecoverBalance } from "@/components/gacha/RecoverBalance"

export default function GachaLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <RecoverBalance className="mb-4" />
      {children}
    </>
  )
}
