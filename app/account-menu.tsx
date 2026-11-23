"use client";
import Link from "next/link";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";

export type AccountMenuProps = {
  current?: string | null;
  // Resolves once signing out is done; the item stays pending until then.
  onSignOut: () => Promise<unknown>;
  defaultOpen?: boolean;
};

export function AccountMenu({ current, onSignOut, defaultOpen }: AccountMenuProps) {
  const here = current === "account";
  return (
    <Menu defaultOpen={defaultOpen} pendingAnnouncement="Signing out">
      <MenuTrigger className="account-trigger" data-current={here ? "" : undefined}>
        Account
      </MenuTrigger>
      <MenuContent className="account-menu" align="end" sideOffset={0} collisionPadding={8}>
        <MenuItem render={<Link href="/account" aria-current={here ? "page" : undefined} />}>
          Settings
        </MenuItem>
        <MenuItem value="sign-out" onSelect={() => onSignOut()}>
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
