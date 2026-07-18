import { ImageResponse } from "next/og";
import { centroIconElement } from "@/lib/centroIconElement";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(centroIconElement(180), { ...size });
}
