// The Cellar lives on the gacha stage now (/gacha/cellar — a universe in the
// picker rail, rendered exactly as a pack). This route only forwards old
// links. useCellar.ts beside it is the chain wiring the stage drives.

import { redirect } from "next/navigation"

export default function WineRedirect() {
  redirect("/gacha/cellar")
}
