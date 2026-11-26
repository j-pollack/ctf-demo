"use client";
import { useFormStatus } from "react-dom";

export const saveButtonState = (pending: boolean) => ({
  label: pending ? "Saving…" : "Save",
  disabled: pending,
});

// The submit button of an admin form. It says so while the form's action is running, and it
// cannot be pressed a second time until the action returns.
export function SaveButton() {
  const { pending } = useFormStatus();
  const { label, disabled } = saveButtonState(pending);
  return (
    <button type="submit" disabled={disabled} aria-busy={pending}>
      {label}
    </button>
  );
}
