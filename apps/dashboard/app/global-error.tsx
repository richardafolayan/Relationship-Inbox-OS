"use client";

import { useEffect } from "react";
import { diagnosticMessage } from "@/lib/consumer-failure";
import { APP_NAME } from "@/lib/branding";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[consumer-failure]", {
      code: "UNEXPECTED",
      phase: "global-render",
      digest: error.digest ?? null,
      diagnostic: diagnosticMessage(error),
      retrySafe: false,
      dataUncertain: true,
      deliveryUncertain: false
    });
  }, [error]);

  return (
    <html lang="en-GB">
      <body style={{ margin: 0, background: "#f7f5ef", color: "#24231f", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ maxWidth: 560, minHeight: "100dvh", margin: "0 auto", maxHeight: "100dvh", overflowY: "auto", padding: "32px 16px" }}>
          <section style={{ border: "1px solid #d8d4c9", borderRadius: 14, background: "#fffdf8", padding: 24 }}>
            <h1 style={{ margin: 0, fontSize: 20 }}>{APP_NAME} needs to reopen this view.</h1>
            <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "#666258" }}>
              Something unexpected interrupted the app. Check any recent change or message before repeating it.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{ marginTop: 18, border: "1px solid #b8b3a7", borderRadius: 999, background: "#ffffff", padding: "8px 14px", color: "#24231f", cursor: "pointer" }}
            >
              Reopen the app
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
