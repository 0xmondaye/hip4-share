// Shared route helpers: error → JSON in the app's existing
// {error:{code,message}} shape.

import { NextResponse } from "next/server"
import { SlabzError } from "@/lib/slabz"
import { AuthError } from "./auth"

export class GachaError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AuthError)
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: e.message } }, { status: 401 })
  if (e instanceof GachaError)
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status })
  if (e instanceof SlabzError)
    return NextResponse.json(
      { error: { code: e.code, message: e.message } },
      { status: e.status >= 500 ? 502 : e.status },
    )
  if ((e as { code?: string })?.code === "NOT_CONFIGURED")
    return NextResponse.json(
      { error: { code: "NOT_CONFIGURED", message: "gacha is not configured" } },
      { status: 503 },
    )
  if ((e as { code?: string })?.code === "QUOTE_SHORT")
    // sponsorship misconfigured/broken upstream — quote refused BEFORE any
    // signature, so surfacing the real amounts is safe and speeds up triage
    return NextResponse.json(
      { error: { code: "QUOTE_SHORT", message: (e as Error).message } },
      { status: 502 },
    )
  console.error("[gacha] route error", e)
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "something went wrong" } },
    { status: 500 },
  )
}
