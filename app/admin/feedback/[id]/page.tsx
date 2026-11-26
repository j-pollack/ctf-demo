import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { feedbackThread } from "@/lib/feedback-mail";
import { GameError } from "@/lib/policy";
import { closeFeedback, replyFeedback } from "../../actions";
import { FeedbackThreadView } from "./feedback-thread";

export const dynamic = "force-dynamic";
export const metadata = { title: "Message · Admin · Capture the flag", robots: { index: false } };

export default async function FeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  // A refused caller or an unknown row is not-found; any other error is a real failure.
  const thread = await feedbackThread(await headers(), (await params).id).catch((error) => {
    if (error instanceof GameError) return null;
    throw error;
  });
  if (!thread) notFound();
  const { error } = await searchParams;
  return (
    <main className="admin" data-testid="page-admin-feedback">
      <header className="admin-head">
        <a href="/admin" className="wordmark">
          Capture the flag<span>_</span>
        </a>
        <span>Admin · all times UTC</span>
      </header>
      <FeedbackThreadView
        thread={thread}
        error={error === "reply" || error === "close" ? error : undefined}
        reply={replyFeedback}
        close={closeFeedback}
      />
    </main>
  );
}
