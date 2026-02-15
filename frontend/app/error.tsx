"use client";

import React from "react";

export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  const { error, reset } = props;

  React.useEffect(() => {
    console.error("[finance-hub] uncaught UI error", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#070A12] p-6 text-white">
      <div className="mx-auto max-w-2xl rounded-3xl border border-red-400/30 bg-red-500/10 p-6">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="mt-2 text-sm text-white/80">
          {error?.message || "Unexpected frontend error."}
        </p>
        <button
          className="mt-4 rounded-2xl border border-white/20 bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
          onClick={reset}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
