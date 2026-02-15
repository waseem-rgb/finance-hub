import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ROLE_COOKIE_KEY = "finance_hub_role";
const VALID_ROLES = new Set(["CFO", "CEO", "Director", "Shareholder", "CB"]);

function isPublicPath(pathname: string) {
  return pathname.startsWith("/_next") || pathname.startsWith("/favicon.ico") || pathname.startsWith("/role-select");
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const role = request.cookies.get(ROLE_COOKIE_KEY)?.value;
  if (!role || !VALID_ROLES.has(role)) {
    const redirectUrl = new URL("/role-select", request.url);
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (pathname.startsWith("/roles") && role !== "CFO") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|.*\\..*).*)"],
};
