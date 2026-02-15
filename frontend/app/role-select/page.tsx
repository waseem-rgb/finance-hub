"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DemoRole, VALID_ROLES, setRoleForDemo } from "@/lib/roleAuth";

const ROLE_DESCRIPTIONS: Record<DemoRole, string> = {
  CFO: "Full CFO view with governance, evidence, AI assistant, uploads, and controls.",
  CEO: "Executive overview and governance with limited operational controls.",
  Director: "Executive and governance view with board-focused drilldowns.",
  Shareholder: "Shareholder-only overview with limited KPI visibility.",
  CB: "Regulatory-style executive/governance perspective.",
};

export default function RoleSelectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";

  function chooseRole(role: DemoRole) {
    setRoleForDemo(role);
    router.replace(nextPath);
  }

  return (
    <div className="min-h-screen bg-[#070A12] p-6 text-white">
      <div className="mx-auto max-w-4xl">
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
          <h1 className="text-2xl font-semibold tracking-tight">Finance Hub Demo Login</h1>
          <p className="mt-2 text-sm text-white/70">Select a role to continue.</p>
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {VALID_ROLES.map((role) => (
              <button
                key={role}
                className="rounded-2xl border border-white/10 bg-white/5 p-4 text-left transition hover:bg-white/10"
                onClick={() => chooseRole(role)}
              >
                <p className="text-sm font-semibold">{role}</p>
                <p className="mt-1 text-xs text-white/70">{ROLE_DESCRIPTIONS[role]}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
