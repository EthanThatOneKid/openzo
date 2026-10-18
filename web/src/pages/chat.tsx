import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useEveAgent } from "eve/react";
import type { EveMessage, EveMessagePart } from "eve/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Paperclip,
  Square,
  TerminalSquare,
  Wrench,
  X,
  AlertTriangle,
  Search,
  Globe,
  FilePen,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import { api, authHeaders, authUrl } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

type ToolPart = Extract<EveMessagePart, { type: "dynamic-tool" }>;

const SUGGESTIONS = [
  "What's in my workspace? Give me a quick tour.",
  "Write a Python script that fetches the Hacker News front page and saves the titles to hn.md",
  "Set up a tiny Bun web server in ~/hello and tell me how to run it",
  "Search the web for the latest gVisor release and summarise what changed",
];

const TOOL_ICON: Record<string, typeof Wrench> = {
  bash: TerminalSquare,
  read: FileText,
  write: FilePen,
  edit: FilePen,
  glob: Search,
  grep: Search,
  web_search: Globe,
  webfetch: Globe,
  look: Eye,
};

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pick = i.command ?? i.path ?? i.file_path ?? i.pattern ?? i.query ?? i.url ?? i.message ?? i.description;
  if (typeof pick === "string") return pick.length > 140 ? `${pick.slice(0, 137)}…` : pick;
  return name === "todo" ? "updated the task list" : JSON.stringify(i).slice(0, 140);
}

// Workspace media a tool produced (generate_image, generate_speech…), previewed inline.
const MEDIA_PATH = /\/workspace\/[^\s"'`,;<>]+?\.(png|jpe?g|webp|gif|mp3|wav|ogg|m4a|flac|mp4|webm|mov)(?=$|[\s"'`,;<>])/gi;

function MediaPreview({ text }: { text: string }) {
  const paths = [...new Set([...text.matchAll(MEDIA_PATH)].map((m) => m[0]))].slice(0, 6);
  if (!paths.length) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t px-3 py-2">
      {paths.map((p) => {
        const src = authUrl(`/api/files/raw?path=${encodeURIComponent(p.slice("/workspace".length))}`);
        const ext = p.split(".").pop()!.toLowerCase();
        if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return <audio key={p} controls src={src} className="h-9 max-w-full" title={p} />;
        if (["mp4", "webm", "mov"].includes(ext)) return <video key={p} controls src={src} className="max-h-72 max-w-full rounded-md border" title={p} />;
        return (
          <a key={p} href={src} target="_blank" rel="noreferrer" title={p}>
            <img src={src} alt={p} className="max-h-72 max-w-full rounded-md border" loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}

function outputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  const o = output as Record<string, unknown>;
  if (o.type === "json" && o.value !== undefined) return outputText(o.value);
  if (o.type === "text" && typeof o.value === "string") return o.value;
  if (typeof o.stdout === "string" || typeof o.stderr === "string") {
    return [o.stdout, o.stderr].filter((x) => typeof x === "string" && x).join("\n") + (o.exitCode !== undefined && o.exitCode !== 0 ? `\n[exit ${o.exitCode}]` : "");
  }
  if (typeof o.content === "string") return o.content;
  return JSON.stringify(output, null, 2);
}

function ToolCard({ part, onRespond }: { part: ToolPart; onRespond: (requestId: string, r: { optionId?: string; text?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [freeform, setFreeform] = useState("");
  const req = part.toolMetadata?.eve?.inputRequest;
  const answered = part.toolMetadata?.eve?.inputResponse;
  const kind = part.toolMetadata?.eve?.kind;
  const Icon = TOOL_ICON[part.toolName] ?? (kind === "subagent-call" ? Brain : Wrench);
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
  const out = part.state === "output-available" ? outputText(part.output) : failed ? part.errorText : "";

  if (req && !answered && part.state !== "output-available") {
    return (
      <div className="my-2 rounded-xl border bg-card p-4 shadow-xs">
        <p className="text-sm font-medium">{req.prompt}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(req.options ?? []).map((o) => (
            <button
              key={o.id}
              onClick={() => onRespond(req.requestId, { optionId: o.id })}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-sm hover:bg-accent",
                o.style === "primary" && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                o.style === "danger" && "border-destructive/40 text-destructive",
              )}
              title={o.description}
            >
              {o.label}
            </button>
          ))}
        </div>
        {(req.allowFreeform || !req.options?.length) && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (freeform.trim()) onRespond(req.requestId, { text: freeform.trim() });
            }}
          >
            <input value={freeform} onChange={(e) => setFreeform(e.target.value)} placeholder="Type an answer…" className="flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
            <button className="rounded-lg bg-primary px-3 text-sm text-primary-foreground">Send</button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className={cn("my-1.5 overflow-hidden rounded-lg border bg-card/60 text-sm", failed && "border-destructive/40")}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50">
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : failed ? <AlertTriangle className="size-3.5 shrink-0 text-destructive" /> : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="font-mono text-xs font-medium">{part.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{summarizeInput(part.toolName, part.input)}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {part.state === "output-available" && out && <MediaPreview text={out} />}
      {open && (
        <div className="border-t bg-muted/40 px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Input</div>
          <pre className="max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap">{JSON.stringify(part.input, null, 2)}</pre>
          {out && (
            <>
              <div className="mt-2 mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{failed ? "Error" : "Output"}</div>
              <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap">{out}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="my-1.5">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <Brain className={cn("size-3.5", streaming && "animate-pulse")} />
        {streaming ? "Thinking…" : "Thought process"}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="mt-1.5 border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</div>}
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-zo text-[15px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
      title="Copy"
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Message({ message, onRespond }: { message: EveMessage; onRespond: (id: string, r: { optionId?: string; text?: string }) => void }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    const files = message.parts.filter((p) => p.type === "file");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] whitespace-pre-wrap text-secondary-foreground">
          {text}
          {files.map((f, i) => (
            <div key={i} className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Paperclip className="size-3" /> {(f as { filename?: string }).filename ?? "attachment"}
            </div>
          ))}
        </div>
      </div>
    );
  }
  const fullText = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n");
  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Logo className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        {message.parts.map((p, i) => {
          if (p.type === "text") return p.text ? <Markdown key={i} text={p.text} /> : null;
          if (p.type === "reasoning") return <Reasoning key={i} text={p.text} streaming={p.state === "streaming"} />;
          if (p.type === "dynamic-tool") return <ToolCard key={p.toolCallId} part={p} onRespond={onRespond} />;
          if (p.type === "file") return <div key={i} className="text-xs text-muted-foreground">📎 {p.filename ?? p.mediaType}</div>;
          if (p.type === "authorization")
            return (
              <div key={i} className="my-2 rounded-lg border p-3 text-sm">
                {p.displayName} needs authorization{p.authorization?.url && <> — <a className="underline" href={p.authorization.url} target="_blank" rel="noreferrer">open</a></>}
              </div>
            );
          return null;
        })}
        {message.metadata?.status === "failed" && <p className="mt-1 text-xs text-destructive">This turn failed.</p>}
        {fullText.trim() && (
          <div className="mt-1 flex">
            <CopyButton text={fullText} />
          </div>
        )}
      </div>
    </div>
  );
}

interface ChatViewProps {
  conversationId?: string;
  initialSession?: { sessionId?: string; continuationToken?: string; streamIndex: number };
  initialEvents?: unknown[];
}

function ChatView({ conversationId, initialSession, initialEvents }: ChatViewProps) {
  const { refreshConversations } = useSession();
  const agent = useEveAgent({
    headers: () => authHeaders(),
    initialSession,
    initialEvents: initialEvents as never,
  });
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const sessionId = agent.session?.sessionId;
  const messages = agent.data.messages;

  // New chats get their URL as soon as the runtime assigns a session id.
  useEffect(() => {
    if (!conversationId && sessionId) {
      history.replaceState(null, "", `/c/${sessionId}`);
      refreshConversations();
    }
  }, [conversationId, sessionId, refreshConversations]);

  useEffect(() => {
    if (!busy) refreshConversations();
  }, [busy, refreshConversations]);

  useEffect(() => {
    const onNew = () => {
      agent.reset();
      setDraft("");
      history.replaceState(null, "", "/");
      textarea.current?.focus();
    };
    window.addEventListener("openzo:new-chat", onNew);
    return () => window.removeEventListener("openzo:new-chat", onNew);
  }, [agent]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const send = useCallback(
    (text: string) => {
      const body = [text.trim(), ...attachments.map((a) => `[attached file: /workspace${a}]`)].filter(Boolean).join("\n\n");
      if (!body || busy) return;
      setDraft("");
      setAttachments([]);
      stick.current = true;
      agent.send({ message: body }).catch((e) => toast.error(String(e?.message ?? e)));
    },
    [agent, attachments, busy],
  );

  const respond = useCallback(
    (requestId: string, r: { optionId?: string; text?: string }) => {
      agent.send({ inputResponses: [{ requestId, ...r }] }).catch((e) => toast.error(String(e?.message ?? e)));
    },
    [agent],
  );

  const turnId = useMemo(() => {
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const e = agent.events[i] as { type: string; data?: { turnId?: string } };
      if (e.type === "turn.started") return e.data?.turnId;
    }
    return undefined;
  }, [agent.events]);

  const cancel = async () => {
    if (!sessionId) return agent.stop();
    await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(turnId ? { turnId } : {}),
    }).catch(() => {});
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of Array.from(list)) form.append("file", f, f.name);
      const r = await api<{ saved: string[] }>("/api/files/upload?dir=/uploads", { method: "POST", body: form });
      setAttachments((a) => [...a, ...r.saved]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const empty = messages.length === 0 && !busy;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {empty ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 pb-24">
            <h1 className="text-center font-serif text-4xl tracking-tight md:text-5xl">What should we do today?</h1>
            <p className="mt-3 text-center text-sm text-muted-foreground">Your agent has a real shell, your files, and the web. Everything runs on your server.</p>
            <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-xl border bg-card px-4 py-3 text-left text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-14 pb-6 md:px-6 md:pt-8">
            {messages.map((m) => (
              <Message key={m.id} message={m} onRespond={respond} />
            ))}
            {agent.status === "submitted" && (
              <div className="flex items-center gap-2 pl-10 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Waking your runtime…
              </div>
            )}
            {agent.error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {String(agent.error.message ?? agent.error)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 pb-4 md:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-2xl border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {attachments.map((a) => (
                  <span key={a} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                    <Paperclip className="size-3" />
                    {a.split("/").pop()}
                    <button onClick={() => setAttachments((x) => x.filter((y) => y !== a))}>
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  void upload(e.clipboardData.files);
                }
              }}
              rows={1}
              autoFocus
              placeholder="Ask your agent anything…"
              className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center justify-between px-2.5 pb-2.5">
              <div className="flex items-center gap-1">
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
                <button onClick={() => fileInput.current?.click()} className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground" title="Attach files (saved to /workspace/uploads)">
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                </button>
              </div>
              {busy ? (
                <button onClick={cancel} className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground" title="Stop">
                  <Square className="size-3.5" fill="currentColor" />
                </button>
              ) : (
                <button onClick={() => send(draft)} disabled={!draft.trim() && !attachments.length} className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-30" title="Send (Enter)">
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">The agent can run commands and change files in your workspace.</p>
        </div>
      </div>
    </div>
  );
}

function LoadConversation({ id }: { id: string }) {
  const [state, setState] = useState<{ session: ChatViewProps["initialSession"]; events: unknown[] } | { error: string } | null>(null);
  useEffect(() => {
    api<{ session: ChatViewProps["initialSession"]; events: unknown[] }>(`/api/conversations/${encodeURIComponent(id)}`)
      .then((d) => setState({ session: d.session, events: d.events }))
      .catch((e) => setState({ error: (e as Error).message }));
  }, [id]);
  if (!state)
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading conversation…
      </div>
    );
  if ("error" in state) return <div className="flex h-full items-center justify-center text-sm text-destructive">{state.error}</div>;
  return <ChatView conversationId={id} initialSession={state.session} initialEvents={state.events} />;
}

export default function ChatPage() {
  const { id } = useParams();
  return id ? <LoadConversation key={id} id={id} /> : <ChatView />;
}
