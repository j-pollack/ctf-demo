"use client";
import { useFormStatus } from "react-dom";

export function ReplyButton() {
  const { pending } = useFormStatus();
  // aria-disabled keeps the button focusable; the click handler stops a second send.
  return (
    <button
      className="primary"
      aria-disabled={pending}
      onClick={(event) => pending && event.preventDefault()}
      data-testid="feedback-thread-send"
    >
      {pending ? "Sending…" : "Send reply"}
    </button>
  );
}
