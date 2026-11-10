import { permanentRedirect } from "next/navigation";

// The stacked reader is gone; keep old links working.
export default function EvergreenNotesPage() {
  permanentRedirect("/polymath/notes");
}
