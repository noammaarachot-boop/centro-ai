import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getValidAccessToken, GoogleNotConnectedError } from "@/lib/googleAuth/driveTokens";

export const dynamic = "force-dynamic";

// Hands the browser a short-lived Drive access token so the Google
// Picker widget (GoogleDriveFolderPicker.tsx) can open with it — the
// refresh token itself never leaves the server. Called on demand right
// before opening Picker, since a stored access token may have expired
// since page load.
export async function GET() {
  const session = await requireSession();

  try {
    const accessToken = await getValidAccessToken(session.organizationId);
    return NextResponse.json({ accessToken });
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) {
      return NextResponse.json({ error: "not_connected" }, { status: 409 });
    }
    console.error("[google-drive] access-token route failed", error);
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
