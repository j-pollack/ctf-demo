import { headers } from "next/headers";
import { redirect } from "next/navigation";
import SiteHeader from "@/app/site-header";
import { accountSignInPath, safeNextPath } from "@/app/sign-in-path";
import { auth } from "@/lib/auth";
import { AccountPanel, type AccountNotice } from "./account-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account | Capture the flag", robots: { index: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

// The email links land here: Better Auth appends `error` when one fails.
function noticeOf(search: Search): AccountNotice {
  if (one(search.error)) return "link-error";
  const step = one(search.email);
  return step === "confirmed" || step === "changed" ? step : null;
}

export default async function Account({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const next = one(search.next);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.isAnonymous) redirect(accountSignInPath(search));
  return (
    <div className="app" data-testid="page-account">
      <div className="workspace">
        <SiteHeader current="account" />
        <AccountPanel
          email={session.user.email}
          displayName={session.user.displayName ?? null}
          next={next ? safeNextPath(next) : null}
          notice={noticeOf(search)}
        />
      </div>
    </div>
  );
}
