// Client error beacon: signer failures only surface in the user's browser
// console, which made them undiagnosable — mirror them into server logs
// (visible in Vercel). No storage, no external service.
export async function POST(req: Request) {
  const body = await req.text().catch(() => "");
  console.error("[client-error]", body.slice(0, 4000));
  return new Response(null, { status: 204 });
}
