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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#151515" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * The theme, set before the first paint: what the reader chose under
 * Settings ("light" or "dark", kept in this browser), or else what the
 * device prefers. Without it a dark page would flash light, or the other way
 * round. It reads one key and sets one attribute; it holds nothing a reader
 * typed.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("nexus-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The attribute the script sets is not in what the server rendered: that is meant.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen-d font-sans antialiased">{children}</body>
    </html>
  );
}
