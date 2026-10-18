import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Download, File, FilePlus, Folder, FolderPlus, Loader2, Pencil, RefreshCw, Save, Trash2, Upload, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { api, ago, formatBytes } from "@/lib/api";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Entry {
  name: string;
  path: string;
  type: "file" | "dir" | "link";
  size: number;
  mtime: number;
}

const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|env|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|fish|sql|php|lua|swift|dart|vue|svelte|conf|cfg|gitignore|dockerfile|makefile)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

function isText(name: string) {
  return TEXT_EXT.test(name) || !name.includes(".") || /^(Dockerfile|Makefile|README|LICENSE)/i.test(name);
}

function Editor({ path, onClose }: { path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [saving, setSaving] = useState(false);
  const name = path.split("/").pop()!;
  const image = IMG_EXT.test(name);
  const raw = `/api/files/raw?path=${encodeURIComponent(path)}`;

  useEffect(() => {
    if (image || !isText(name)) return;
    fetch(raw)
      .then((r) => r.text())
      .then((t) => {
        setText(t);
        setOrig(t);
      });
  }, [raw, image, name]);

  const save = async () => {
    setSaving(true);
    try {
      await fetch(raw, { method: "PUT", body: text ?? "" }).then((r) => {
        if (!r.ok) throw new Error(`save failed (${r.status})`);
      });
      setOrig(text ?? "");
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2 pl-14 md:pl-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft className="size-4" />
          </Button>
          <span className="truncate font-mono text-sm">{path}</span>
          {text !== null && text !== orig && <span className="text-xs text-amber-600">● unsaved</span>}
        </div>
        <div className="flex items-center gap-2">
          <a href={`${raw}&download=1`} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent">
            <Download className="size-3.5" /> Download
          </a>
          {text !== null && (
            <Button size="sm" onClick={save} disabled={saving || text === orig}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
            </Button>
          )}
        </div>
      </div>
      {image ? (
        <div className="flex flex-1 items-center justify-center overflow-auto bg-muted/30 p-6">
          <img src={raw} alt={name} className="max-h-full max-w-full rounded-lg border shadow-sm" />
        </div>
      ) : text !== null ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              void save();
            }
          }}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-background p-4 font-mono text-[13px] leading-relaxed outline-none"
        />
      ) : isText(name) ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <File className="size-8" /> No preview for this file type.
          <a href={`${raw}&download=1`} className="underline">
            Download it
          </a>
        </div>
      )}
    </div>
  );
}

export default function FilesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const rest = decodeURIComponent(location.pathname.replace(/^\/files/, "")) || "/";
  const params = new URLSearchParams(location.search);
  const openFile = params.get("open");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const upInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<{ entries: Entry[] }>(`/api/files?path=${encodeURIComponent(rest)}${hidden ? "&hidden=1" : ""}`)
      .then((d) => setEntries(d.entries))
      .catch((e) => {
        toast.error(e.message);
        setEntries([]);
      });
  }, [rest, hidden]);

  useEffect(() => {
    setEntries(null);
    load();
  }, [load]);

  const go = (p: string) => navigate(`/files${p === "/" ? "" : p}`);

  const upload = async (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of Array.from(list)) form.append("file", f, f.name);
      const r = await api<{ saved: string[] }>(`/api/files/upload?dir=${encodeURIComponent(rest)}`, { method: "POST", body: form });
      toast.success(`Uploaded ${r.saved.length} file${r.saved.length === 1 ? "" : "s"}`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = (name: string) => `${rest.replace(/\/$/, "")}/${name}`;

  const mkdir = async () => {
    const name = prompt("New folder name");
    if (!name) return;
    await api("/api/files/mkdir", { method: "POST", json: { path: join(name) } }).catch((e) => toast.error(e.message));
    load();
  };

  const newFile = async () => {
    const name = prompt("New file name", "notes.md");
    if (!name) return;
    await fetch(`/api/files/raw?path=${encodeURIComponent(join(name))}`, { method: "PUT", body: "" });
    navigate(`${location.pathname}?open=${encodeURIComponent(join(name))}`);
  };

  const rename = async (e: Entry) => {
    const name = prompt("Rename to", e.name);
    if (!name || name === e.name) return;
    await api("/api/files/move", { method: "POST", json: { from: e.path, to: join(name) } }).catch((err) => toast.error(err.message));
    load();
  };

  const remove = async (e: Entry) => {
    if (!confirm(`Delete ${e.name}${e.type === "dir" ? " and everything in it" : ""}?`)) return;
    await api(`/api/files?path=${encodeURIComponent(e.path)}`, { method: "DELETE" }).catch((err) => toast.error(err.message));
    load();
  };

  if (openFile) return <Editor path={openFile} onClose={() => navigate(location.pathname)} />;

  const crumbs = rest.split("/").filter(Boolean);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <PageHeader title="Files" description="Your persistent workspace. The agent sees exactly these files at /workspace.">
        <Button variant="ghost" size="sm" onClick={() => setHidden((h) => !h)} title={hidden ? "Hide dotfiles" : "Show dotfiles"}>
          {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={load} title="Refresh">
          <RefreshCw className="size-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={newFile}>
          <FilePlus className="size-4" /> File
        </Button>
        <Button variant="outline" size="sm" onClick={mkdir}>
          <FolderPlus className="size-4" /> Folder
        </Button>
        <input ref={upInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <Button size="sm" onClick={() => upInput.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload
        </Button>
      </PageHeader>

      <div className="flex items-center gap-1 px-6 py-2.5 text-sm">
        <Link to="/files" className="rounded px-1.5 py-0.5 font-mono text-muted-foreground hover:bg-accent hover:text-foreground">
          workspace
        </Link>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <button onClick={() => go(`/${crumbs.slice(0, i + 1).join("/")}`)} className="rounded px-1.5 py-0.5 font-mono hover:bg-accent">
              {c}
            </button>
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        {entries === null ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
            <Folder className="size-8 opacity-50" />
            This folder is empty. Drop files here or ask the agent to make something.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            {entries.map((e) => (
              <div key={e.path} className="group flex items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-accent/40">
                <button
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => (e.type === "dir" ? go(e.path) : navigate(`${location.pathname}?open=${encodeURIComponent(e.path)}`))}
                >
                  {e.type === "dir" ? <Folder className="size-4 shrink-0 fill-amber-200/60 text-amber-600" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
                  <span className={cn("truncate text-sm", e.type === "dir" && "font-medium")}>{e.name}</span>
                </button>
                <span className="hidden w-20 text-right text-xs text-muted-foreground sm:block">{e.type === "dir" ? "" : formatBytes(e.size)}</span>
                <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">{ago(e.mtime)}</span>
                <div className="flex w-24 justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {e.type !== "dir" && (
                    <a href={`/api/files/raw?path=${encodeURIComponent(e.path)}&download=1`} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Download">
                      <Download className="size-3.5" />
                    </a>
                  )}
                  <button onClick={() => rename(e)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Rename">
                    <Pencil className="size-3.5" />
                  </button>
                  <button onClick={() => remove(e)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive" title="Delete">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-background/80 text-sm font-medium">
          Drop to upload into {rest}
        </div>
      )}
    </div>
  );
}
