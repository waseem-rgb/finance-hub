"use client";

import React from "react";
import { Role } from "@/components/dashboard/RoleContext";

export default function RoleGuard(props: { role: Role; allowed: Role[]; children: React.ReactNode }) {
  const { role, allowed, children } = props;
  if (!allowed.includes(role)) {
    return (
      <div className="rounded-2xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">
        Access denied for role: {role}
      </div>
    );
  }
  return <>{children}</>;
}
