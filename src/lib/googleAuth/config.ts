/**
 * Centro requests only drive.file — per-file access. Under this scope the
 * app can see/modify only files it created itself, plus whatever the user
 * explicitly grants through the Google Picker (see
 * GoogleDriveFolderPicker.tsx). It can never list or read the rest of a
 * user's Drive. This is why "select an existing folder" goes through
 * Picker rather than a server-side files.list call — drive.file alone
 * would not grant visibility into folders Centro didn't create.
 */
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth is not configured. Set NEXT_PUBLIC_GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI."
    );
  }

  return { clientId, clientSecret, redirectUri };
}
