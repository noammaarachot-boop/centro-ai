import { redirect } from "next/navigation";

// A real, bookmarkable /register URL for "Don't have an account? Create
// Account" links, without duplicating AuthTabs' markup or introducing a
// second registration surface — /login?mode=register just opens AuthTabs
// on its Register tab.
export default function RegisterPage() {
  redirect("/login?mode=register");
}
