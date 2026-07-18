import { ImageResponse } from "next/og";
import { centroIconElement } from "@/lib/centroIconElement";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(centroIconElement(32), { ...size });
}
