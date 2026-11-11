import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Xiero Nexus AI",
    template: "%s · Xiero Nexus AI",
  },
  description: "One Command. Infinite Intelligence. — a configurable multi-provider AI control plane.",
  applicationName: "Xiero Nexus AI",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#090b0e",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
