import { NextResponse } from "next/server";

/*
 * /api/v1/dossiers moved to /api/v1/projects (Perplexity-Spaces parity).
 * Old clients keep working: a GET or POST here redirects with the same verb.
 */
export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/api/v1/projects", request.url), 308);
}

export async function POST(request: Request) {
  return NextResponse.redirect(new URL("/api/v1/projects", request.url), 308);
}
