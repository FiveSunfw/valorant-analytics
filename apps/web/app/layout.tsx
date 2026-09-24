import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./redesign.css";
import "./client.css";

export const metadata: Metadata = {
  title: "VALORANT Analytics · Post-match Review",
  description: "Evidence-bound competitive post-match analysis.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
