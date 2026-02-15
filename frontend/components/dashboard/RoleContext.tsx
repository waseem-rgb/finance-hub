import React from "react";

export type Role = "CFO" | "CEO" | "Director" | "Shareholder" | "CB";

type RoleContextValue = {
  role: Role;
  setRole: (role: Role) => void;
};

const RoleContext = React.createContext<RoleContextValue | undefined>(undefined);

export function RoleProvider(props: { role: Role; setRole: (role: Role) => void; children: React.ReactNode }) {
  return <RoleContext.Provider value={{ role: props.role, setRole: props.setRole }}>{props.children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = React.useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
