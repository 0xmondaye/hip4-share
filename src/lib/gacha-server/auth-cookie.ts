// With a Privy custom auth domain (server-cookie mode) the tokens ride as
// HttpOnly cookies — getIdentityToken() in the browser returns null, so the
// client can't attach the header. Privy's documented server pattern is to
// read the cookie; headers stay first for localStorage-mode sessions.
// Own module (no "@/" imports) so the test runs under plain node.
export function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie")
  if (!header) return null
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1))
  }
  return null
}
