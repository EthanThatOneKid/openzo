import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Bootstrap, type Conversation } from "./api";

interface SessionCtx {
  boot: Bootstrap | null;
  reload: () => Promise<void>;
  conversations: Conversation[];
  refreshConversations: () => void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const reload = useCallback(async () => {
    setBoot(await api<Bootstrap>("/api/bootstrap"));
  }, []);
  const refreshConversations = useCallback(() => {
    api<{ conversations: Conversation[] }>("/api/conversations")
      .then((d) => setConversations(d.conversations))
      .catch(() => {});
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (boot?.user) refreshConversations();
  }, [boot?.user, refreshConversations]);
  return <Ctx.Provider value={{ boot, reload, conversations, refreshConversations }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}
