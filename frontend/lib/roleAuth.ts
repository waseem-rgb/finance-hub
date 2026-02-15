export const ROLE_COOKIE_KEY = "finance_hub_role";
export const VALID_ROLES = ["CFO", "CEO", "Director", "Shareholder", "CB"] as const;
export type DemoRole = (typeof VALID_ROLES)[number];

export function isValidRole(role: string | null | undefined): role is DemoRole {
  return !!role && (VALID_ROLES as readonly string[]).includes(role);
}

export function setRoleForDemo(role: DemoRole) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ROLE_COOKIE_KEY, role);
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${ROLE_COOKIE_KEY}=${encodeURIComponent(role)}; Path=/; SameSite=Lax${secure}; Max-Age=${60 * 60 * 24 * 30}`;
}

export function getStoredRole(): DemoRole | null {
  if (typeof window === "undefined") return null;
  const local = window.localStorage.getItem(ROLE_COOKIE_KEY);
  if (isValidRole(local)) return local;
  return null;
}

export function clearRoleForDemo() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ROLE_COOKIE_KEY);
  document.cookie = `${ROLE_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
}
