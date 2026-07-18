import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Centro",
  description: "Centro operational console.",
};

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
