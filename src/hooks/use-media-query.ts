import { useEffect, useState } from "react"

/** shadcn responsive-dialog helper: true when `query` matches.
 * Starts false (SSR) — dialog content only renders on open, so no flash. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mql = matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])
  return matches
}
