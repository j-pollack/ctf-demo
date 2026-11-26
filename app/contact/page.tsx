import SiteFooter from "@/app/site-footer";
import SiteHeader from "@/app/site-header";
import { ContactForm } from "./contact-form";

export const metadata = { title: "Contact | Capture the flag" };

export default function ContactPage() {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="landing-main contact">
        <h1>Contact</h1>
        <p>Questions, ideas or problems with the game? Write to us.</p>
        <ContactForm />
      </main>
      <SiteFooter />
    </div>
  );
}
