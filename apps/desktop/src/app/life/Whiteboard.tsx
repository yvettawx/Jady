// 白板 (H6): notes, cards, pictures and links placed freely and joined by lines. Each node and line
// is its own entry in the item's CRDT document, so two computers editing different ones both keep
// their change. Drawn by hand with plain elements: no canvas library, nothing to license.
import { useEffect, useRef, useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/States";
import { showToast } from "../../ui/toast";
import type { PanelProps } from "../../workspace/registry";
import { failed, openById } from "../actions";
import { api, itemsChanged } from "../api";
import { titleOf } from "../model";
import { library } from "../store";

export interface BoardNode {
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  item?: string;
  blob?: string;
  url?: string;
}
export interface BoardLine {
  from: string;
  to: string;
}
type Entry = BoardNode | BoardLine;
const isLine = (e: Entry): e is BoardLine => "from" in e;

const fresh = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function parseBoard(raw: Record<string, string>) {
  const nodes = new Map<string, BoardNode>();
  const lines = new Map<string, BoardLine>();
  for (const [k, v] of Object.entries(raw)) {
    try {
      const e = JSON.parse(v) as Entry;
      if (isLine(e)) lines.set(k, e);
      else nodes.set(k, e);
    } catch {
      // Something from a newer version: left alone, not shown.
    }
  }
  return { nodes, lines };
}

/** The lines left once a node is gone, as the removals to send. */
export function removalsFor(id: string, lines: Map<string, BoardLine>) {
  const out: Record<string, null> = { [id]: null };
  for (const [k, l] of lines) if (l.from === id || l.to === id) out[k] = null;
  return out;
}

export function WhiteboardPanel({ contentId, workspace }: PanelProps) {
  const t = useT();
  const id = contentId;
  const [nodes, setNodes] = useState(new Map<string, BoardNode>());
  const [lines, setLines] = useState(new Map<string, BoardLine>());
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [picked, setPicked] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [images, setImages] = useState(new Map<string, string>());
  const [pickingItem, setPickingItem] = useState<{ query: string; hits: ItemView[] } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const press = useRef<{
    node?: string;
    resize?: boolean;
    x: number;
    y: number;
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void api.canvasGet(id).then((raw) => {
      if (!live) return;
      const b = parseBoard(raw as Record<string, string>);
      setNodes(b.nodes);
      setLines(b.lines);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    for (const n of nodes.values())
      if (n.blob && !images.has(n.blob)) {
        const name = n.blob;
        void api.blobGet(name).then((data) => setImages((m) => new Map(m).set(name, data)));
      }
  }, [nodes, images]);

  const save = (changes: Record<string, string | null>) => {
    void api
      .canvasUpdate(id, changes)
      .then(() => itemsChanged())
      .catch(failed(t, t("whiteboard.title")));
  };

  const centre = () => {
    const n = nodes.size;
    return {
      x: (40 - view.x) / view.z + (n % 4) * 210,
      y: (40 - view.y) / view.z + (Math.floor(n / 4) % 6) * 110,
    };
  };
  const add = (extra: Partial<BoardNode>, size = { w: 180, h: 80 }) => {
    const key = fresh("n");
    const node: BoardNode = { ...centre(), ...size, ...extra };
    setNodes((m) => new Map(m).set(key, node));
    setPicked(key);
    save({ [key]: JSON.stringify(node) });
    return key;
  };
  const change = (key: string, next: BoardNode, write = true) => {
    setNodes((m) => new Map(m).set(key, next));
    if (write) save({ [key]: JSON.stringify(next) });
  };
  const remove = (key: string) => {
    const gone = removalsFor(key, lines);
    setNodes((m) => {
      const n = new Map(m);
      n.delete(key);
      return n;
    });
    setLines((m) => {
      const n = new Map(m);
      for (const k of Object.keys(gone)) n.delete(k);
      return n;
    });
    setPicked(null);
    save(gone);
  };

  const onNodeDown = (e: React.PointerEvent, key: string, resize = false) => {
    e.stopPropagation();
    const n = nodes.get(key);
    if (!n) return;
    if (linking && linking !== key) {
      const line = fresh("l");
      const value: BoardLine = { from: linking, to: key };
      setLines((m) => new Map(m).set(line, value));
      save({ [line]: JSON.stringify(value) });
      setLinking(null);
      return;
    }
    setPicked(key);
    if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
    press.current = {
      node: key,
      resize,
      x: e.clientX,
      y: e.clientY,
      sx: n.x,
      sy: n.y,
      sw: n.w,
      sh: n.h,
      moved: false,
    };
    surface.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) p.moved = true;
    if (!p.node) {
      setView((v) => ({ ...v, x: p.sx + dx, y: p.sy + dy }));
      return;
    }
    const n = nodes.get(p.node);
    if (!n) return;
    change(
      p.node,
      p.resize
        ? { ...n, w: Math.max(80, p.sw + dx / view.z), h: Math.max(40, p.sh + dy / view.z) }
        : { ...n, x: p.sx + dx / view.z, y: p.sy + dy / view.z },
      false,
    );
  };
  const onUp = () => {
    const p = press.current;
    press.current = null;
    if (!p?.node || !p.moved) return;
    const n = nodes.get(p.node);
    if (n) save({ [p.node]: JSON.stringify(n) });
  };

  const addImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(",")[1] ?? "";
        void api
          .blobPut(data)
          .then((blob) => add({ blob }, { w: 240, h: 180 }))
          .catch(failed(t, t("whiteboard.image")));
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const findItems = (query: string) => {
    setPickingItem({ query, hits: pickingItem?.hits ?? [] });
    if (!query.trim()) return setPickingItem({ query, hits: [] });
    void api.search(query, 8).then((hits) => {
      setPickingItem((p) =>
        p && p.query === query ? { query, hits: hits.map((h) => h.item) } : p,
      );
    });
  };

  const titleOfNode = (item: string) => {
    const known =
      library().items.find((x) => x.id === item) ?? library().directory.find((x) => x.id === item);
    return known ? titleOf(t, known) : t("whiteboard.gone");
  };

  if (!loaded) return null;
  const centreOf = (n: BoardNode) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
  return (
    <div className="dem-board-page">
      <header className="dem-life-head">
        <Button size="sm" icon="edit" onPress={() => add({ text: "" })}>
          {t("whiteboard.text")}
        </Button>
        <Button size="sm" icon="file" onPress={() => setPickingItem({ query: "", hits: [] })}>
          {t("whiteboard.item")}
        </Button>
        <Button size="sm" icon="image" onPress={addImage}>
          {t("whiteboard.image")}
        </Button>
        <Button size="sm" icon="link" onPress={() => setUrl("")}>
          {t("whiteboard.link")}
        </Button>
        <span className="dem-life-gap" />
        {picked && (
          <>
            <Button
              size="sm"
              variant={linking ? "primary" : "quiet"}
              onPress={() => setLinking(linking ? null : picked)}
            >
              {t(linking ? "whiteboard.linking" : "whiteboard.line")}
            </Button>
            <Button size="sm" variant="quiet" onPress={() => remove(picked)}>
              {t("whiteboard.remove")}
            </Button>
          </>
        )}
      </header>
      {url !== null && (
        <form
          className="dem-board-picker"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^https?:\/\//.test(url)) {
              add({ url }, { w: 220, h: 48 });
              setUrl(null);
            } else showToast({ text: t("whiteboard.linkBad") });
          }}
        >
          <input
            autoFocus
            className="dem-fields-input"
            aria-label={t("whiteboard.linkHint")}
            placeholder={t("whiteboard.linkHint")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setUrl(null);
            }}
          />
        </form>
      )}
      {pickingItem && (
        <div className="dem-board-picker">
          <input
            autoFocus
            className="dem-fields-input"
            aria-label={t("whiteboard.find")}
            placeholder={t("whiteboard.find")}
            value={pickingItem.query}
            onChange={(e) => findItems(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPickingItem(null);
            }}
          />
          <ul>
            {pickingItem.hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  className="dem-nav-open"
                  onClick={() => {
                    add({ item: h.id }, { w: 200, h: 56 });
                    setPickingItem(null);
                  }}
                >
                  <span className="dem-nav-title">{titleOf(t, h)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        ref={surface}
        className="dem-board-surface"
        onPointerDown={(e) => {
          setPicked(null);
          setLinking(null);
          press.current = {
            x: e.clientX,
            y: e.clientY,
            sx: view.x,
            sy: view.y,
            sw: 0,
            sh: 0,
            moved: false,
          };
          surface.current?.setPointerCapture(e.pointerId);
        }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={(e) => {
          const r = surface.current?.getBoundingClientRect();
          if (!r) return;
          const z = Math.min(3, Math.max(0.2, view.z * (e.deltaY > 0 ? 0.92 : 1.08)));
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          setView({
            z,
            x: px - ((px - view.x) / view.z) * z,
            y: py - ((py - view.y) / view.z) * z,
          });
        }}
      >
        {!nodes.size && <EmptyState icon="edit" title={t("whiteboard.empty")} />}
        <div
          className="dem-board-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          <svg className="dem-board-lines">
            {[...lines].map(([k, l]) => {
              const a = nodes.get(l.from);
              const b = nodes.get(l.to);
              if (!a || !b) return null;
              const p = centreOf(a);
              const q = centreOf(b);
              return <line key={k} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
            })}
          </svg>
          {[...nodes].map(([k, n]) => (
            <div
              key={k}
              className="dem-board-node"
              data-picked={picked === k ? "" : undefined}
              style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
              onPointerDown={(e) => onNodeDown(e, k)}
            >
              {n.text !== undefined && (
                <textarea
                  aria-label={t("whiteboard.text")}
                  defaultValue={n.text}
                  onBlur={(e) => {
                    if (e.target.value !== n.text) change(k, { ...n, text: e.target.value });
                  }}
                />
              )}
              {n.item && (
                <button
                  type="button"
                  className="dem-nav-open"
                  onDoubleClick={() => openById(workspace, t, n.item ?? "", { kind: "temp" })}
                >
                  <span className="dem-nav-title">{titleOfNode(n.item)}</span>
                </button>
              )}
              {n.blob &&
                (images.has(n.blob) ? (
                  <img alt="" draggable={false} src={`data:image/*;base64,${images.get(n.blob)}`} />
                ) : null)}
              {n.url && <span className="dem-board-url">{n.url}</span>}
              <i
                className="dem-board-size"
                onPointerDown={(e) => {
                  e.preventDefault();
                  onNodeDown(e, k, true);
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
