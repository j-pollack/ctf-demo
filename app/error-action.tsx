import Link from "next/link";
import { accountPath } from "@/app/sign-in-path";
import { NAME_REQUIRED } from "@/lib/display-name-rule";

// An error the player fixes on another page carries a link to it.
export function ErrorAction({ message }: { message: string }) {
  return message === NAME_REQUIRED ? (
    <Link className="link" href={accountPath("/play")}>
      Choose a display name
    </Link>
  ) : null;
}
