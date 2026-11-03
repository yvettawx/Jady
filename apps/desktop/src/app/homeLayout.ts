// Where each widget sits on a space's home page, and which are shown (PRD H4). Data per space; the
// registry says what exists, this says where.
import { useEffect, useMemo, useState } from "react";
import type { HomeWidget } from "../home/HomeGrid";
import { api } from "./api";

interface Saved {
  places: Record<string, Pick<HomeWidget, "col" | "row" | "w" | "h">>;
  hidden: string[];
}

const EMPTY: Saved = { places: {}, hidden: [] };

export function useHomeLayout(space: string, widgets: HomeWidget[]) {
  const key = `ui-home-${space}`;
  const [saved, setSaved] = useState<Saved>(EMPTY);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.localGet(key).then((raw) => {
      if (!alive) return;
      try {
        setSaved(raw ? (JSON.parse(raw) as Saved) : EMPTY);
      } catch {
        setSaved(EMPTY);
      }
    });
    return () => {
      alive = false;
    };
  }, [key]);
  const store = (next: Saved) => {
    setSaved(next);
    void api.localSet(key, JSON.stringify(next));
  };
  const placed = useMemo(
    () =>
      widgets
        .filter((w) => !saved.hidden.includes(w.id))
        .map((w) => ({ ...w, ...saved.places[w.id] })),
    [widgets, saved],
  );
  const hidden = widgets.filter((w) => saved.hidden.includes(w.id));
  return {
    placed,
    hidden,
    editing,
    setEditing,
    place: (id: string, at: Pick<HomeWidget, "col" | "row" | "w" | "h">) =>
      store({ ...saved, places: { ...saved.places, [id]: at } }),
    remove: (id: string) => store({ ...saved, hidden: [...saved.hidden, id] }),
    add: (id: string) => store({ ...saved, hidden: saved.hidden.filter((x) => x !== id) }),
  };
}
