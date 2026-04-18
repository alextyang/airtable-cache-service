import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Airtable Cache Service",
  description: "Persistent Airtable cache and preload proxy.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
