"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, FolderSearch } from "lucide-react";
import { buttonVariants } from "./Button";
import { selectGoogleDriveFolder } from "@/app/onboarding/actions";

// Google's Picker widget has no first-party npm package with official
// types — these declarations cover only the handful of calls this file
// actually makes, matching this codebase's "no unnecessary dependencies"
// convention (see src/lib/csv.ts's hand-written parser for the same
// reasoning) rather than installing a full @types package for four calls.
interface PickerDoc {
  id: string;
  name: string;
}
interface PickerResponse {
  action: string;
  docs?: PickerDoc[];
}
interface PickerBuilderInstance {
  addView: (view: unknown) => PickerBuilderInstance;
  setOAuthToken: (token: string) => PickerBuilderInstance;
  setDeveloperKey: (key: string) => PickerBuilderInstance;
  setCallback: (cb: (response: PickerResponse) => void) => PickerBuilderInstance;
  build: () => { setVisible: (visible: boolean) => void };
}
interface DocsViewInstance {
  setSelectFolderEnabled: (enabled: boolean) => DocsViewInstance;
  setIncludeFolders: (include: boolean) => DocsViewInstance;
  setMimeTypes: (mimeTypes: string) => DocsViewInstance;
}
declare global {
  interface Window {
    gapi?: { load: (api: string, callback: () => void) => void };
    google?: {
      picker: {
        PickerBuilder: new () => PickerBuilderInstance;
        DocsView: new (viewId: string) => DocsViewInstance;
        ViewId: { FOLDERS: string };
        Action: { PICKED: string };
      };
    };
  }
}

const PICKER_SCRIPT_SRC = "https://apis.google.com/js/api.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function loadGapiScript(): Promise<void> {
  if (window.gapi) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${PICKER_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google API script")));
      return;
    }
    const script = document.createElement("script");
    script.src = PICKER_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google API script"));
    document.body.appendChild(script);
  });
}

function loadPickerLibrary(): Promise<void> {
  return new Promise((resolve, reject) => {
    window.gapi?.load("picker", () => resolve());
    if (!window.gapi) reject(new Error("gapi did not load"));
  });
}

export function GoogleDriveFolderPicker() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "opening" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function openPicker() {
    setStatus("opening");
    setErrorMessage(null);

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    if (!apiKey) {
      setStatus("error");
      setErrorMessage("בחירת תיקייה קיימת אינה זמינה כרגע (חסרה תצורת Google API).");
      return;
    }

    try {
      const [tokenRes] = await Promise.all([
        fetch("/api/google-drive/access-token"),
        loadGapiScript().then(loadPickerLibrary),
      ]);

      if (!tokenRes.ok) {
        throw new Error("Could not obtain a Google Drive access token");
      }
      const { accessToken } = (await tokenRes.json()) as { accessToken: string };

      const google = window.google;
      if (!google) throw new Error("Google Picker failed to load");

      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true)
        .setMimeTypes(FOLDER_MIME_TYPE);

      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setCallback(async (response: PickerResponse) => {
          if (response.action !== google.picker.Action.PICKED) {
            setStatus("idle");
            return;
          }
          const folder = response.docs?.[0];
          if (!folder) {
            setStatus("idle");
            return;
          }
          const result = await selectGoogleDriveFolder(folder.id);
          if (result.ok) {
            router.refresh();
          } else {
            setStatus("error");
            setErrorMessage("שמירת התיקייה שנבחרה נכשלה. נסו שוב.");
          }
        })
        .build();

      picker.setVisible(true);
      setStatus("idle");
    } catch (error) {
      console.error("[google-drive] failed to open Picker", error);
      setStatus("error");
      setErrorMessage("פתיחת חלון בחירת התיקייה נכשלה. נסו שוב.");
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={openPicker}
        disabled={status === "opening"}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        {status === "opening" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FolderSearch className="h-3.5 w-3.5" />
        )}
        בחירת תיקייה קיימת
      </button>
      {status === "error" && errorMessage && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
