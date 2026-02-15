"use client";

import React from "react";

export default function RolesPage() {
  const [role, setRole] = React.useState<string | null>(null);

  React.useEffect(() => {
    const storedRole = window.localStorage.getItem("finance_hub_role");
    setRole(storedRole || "CFO");
  }, []);

  if (role !== null && role !== "CFO") {
    return (
      <div className="min-h-screen bg-[#070A12] p-8 text-white">
        <div className="mx-auto max-w-3xl rounded-3xl border border-red-400/30 bg-red-500/10 p-6">
          <h1 className="text-xl font-semibold">Access Denied</h1>
          <p className="mt-2 text-sm text-white/80">
            The Roles & Access page is restricted to CFO.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#070A12] p-8 text-white">
      <div className="mx-auto max-w-3xl rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <h1 className="text-xl font-semibold">Role Permissions</h1>
        <p className="mt-2 text-sm text-white/70">
          This page documents the current frontend-only role scoping rules for the Finance Hub dashboard.
        </p>

        <div className="mt-6 space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <h2 className="text-sm font-semibold">CFO</h2>
            <p className="mt-2 text-xs text-white/70">
              Full access: all KPIs, ratios, variance bridge, evidence drawer, upload and exports.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <h2 className="text-sm font-semibold">CEO</h2>
            <p className="mt-2 text-xs text-white/70">
              Top KPIs and limited ratios; no evidence drawer or uploads.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <h2 className="text-sm font-semibold">Director</h2>
            <p className="mt-2 text-xs text-white/70">
              KPIs and ratios with evidence drawer; variance bridge hidden.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <h2 className="text-sm font-semibold">Shareholder</h2>
            <p className="mt-2 text-xs text-white/70">
              Simplified KPI view; no ratios, variance, uploads, or evidence.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <h2 className="text-sm font-semibold">CB (Regulator)</h2>
            <p className="mt-2 text-xs text-white/70">
              Limited KPI view with regulatory placeholders; no uploads or evidence.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
