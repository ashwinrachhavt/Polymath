import { permanentRedirect } from "next/navigation";

// Linked notes now open as panes beside the note being written, on /polymath/notes; keep old links working.
export default function EvergreenNotesPage() {
  permanentRedirect("/polymath/notes");
}
