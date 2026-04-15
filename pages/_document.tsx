// Next.js still expects a Pages Router document shell while building some fallback pages, even
// though this service's real endpoints live in the App Router.
// Keeping this tiny file avoids production build failures around `/_document`.
import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html>
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
