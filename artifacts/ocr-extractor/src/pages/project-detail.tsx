import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, useParams } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  HardHat,
  BookOpen,
  Receipt,
  ScanLine,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  Send,
  MessageSquare,
  ChevronLeft,
  RefreshCw,
  CheckCircle2,
  Clock,
  XCircle,
  ChevronDown,
  ChevronUp,
  FileText,
  Bot,
  User,
  Sparkles,
} from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Project = {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  documents: ProjectDocument[];
};

type ProjectDocument = {
  id: number;
  projectId: number;
  documentType: "spec" | "construction" | "financial" | "ocr";
  documentId: number;
  documentName: string;
  indexStatus: "pending" | "indexing" | "indexed" | "failed";
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string;
};

type ChatMessage = {
  id: number;
  projectId: number;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[] | null;
  createdAt: string;
};

type ChatSource = {
  documentName: string;
  documentType: string;
  sectionLabel: string | null;
  excerpt: string;
};

type AvailableDoc = {
  id: number;
  fileName: string;
  status: string;
  type: "spec" | "construction" | "financial" | "ocr";
};

const DOC_TYPE_META = {
  spec: { label: "Specification", icon: BookOpen, color: "text-violet-500", bg: "bg-violet-500/10", border: "border-violet-500/20" },
  construction: { label: "Construction Drawing", icon: HardHat, color: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/20" },
  financial: { label: "Financial Doc", icon: Receipt, color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  ocr: { label: "OCR Extract", icon: ScanLine, color: "text-blue-500", bg: "bg-blue-500/10", border: "border-blue-500/20" },
};

const INDEX_STATUS = {
  pending: { label: "Pending", icon: Clock, color: "text-muted-foreground" },
  indexing: { label: "Indexing…", icon: Loader2, color: "text-blue-500", spin: true },
  indexed: { label: "Indexed", icon: CheckCircle2, color: "text-emerald-500" },
  failed: { label: "Failed", icon: XCircle, color: "text-destructive" },
};

const SUGGESTED_QUESTIONS = [
  "What is the compaction range needed for asphalts?",
  "What is the minimum temperature for concrete placement?",
  "What is the air entrainment range for concrete?",
  "What is the inspection protocol for stormwater systems?",
  "How many silt socks are on this project?",
  "What is the prevailing rate for a plumbing foreman?",
];

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const projectId = parseInt(params.id ?? "");

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [question, setQuestion] = useState("");
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const [showAddDoc, setShowAddDoc] = useState(false);
  const [availableDocs, setAvailableDocs] = useState<AvailableDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [addingDocId, setAddingDocId] = useState<string | null>(null);
  const [removingDocId, setRemovingDocId] = useState<number | null>(null);
  const [expandedSources, setExpandedSources] = useState<Set<number>>(new Set());

  const [pollingActive, setPollingActive] = useState(false);

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}`);
      if (!res.ok) throw new Error("Project not found");
      const data = await res.json();
      setProject(data);
      const hasIndexing = data.documents?.some((d: ProjectDocument) => d.indexStatus === "indexing" || d.indexStatus === "pending");
      setPollingActive(hasIndexing);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchChatHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/chat`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages ?? []);
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => {
    if (isNaN(projectId)) return;
    fetchProject();
    fetchChatHistory();
  }, [projectId, fetchProject, fetchChatHistory]);

  useEffect(() => {
    if (!pollingActive) return;
    const interval = setInterval(fetchProject, 3000);
    return () => clearInterval(interval);
  }, [pollingActive, fetchProject]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadAvailableDocs() {
    setDocsLoading(true);
    try {
      const [specRes, conRes, finRes, ocrRes] = await Promise.all([
        fetch(`${API_BASE}/api/spec-extractions`),
        fetch(`${API_BASE}/api/pdf-extractions`),
        fetch(`${API_BASE}/api/financial-extractions`),
        fetch(`${API_BASE}/api/extractions`),
      ]);
      const [specData, conData, finData, ocrData] = await Promise.all([
        specRes.json(), conRes.json(), finRes.json(), ocrRes.json(),
      ]);
      const all: AvailableDoc[] = [
        ...(specData.extractions ?? []).map((d: { id: number; fileName: string; status: string }) => ({ ...d, type: "spec" as const })),
        ...(conData.extractions ?? []).map((d: { id: number; fileName: string; status: string }) => ({ ...d, type: "construction" as const })),
        ...(finData.extractions ?? []).map((d: { id: number; fileName: string; status: string }) => ({ ...d, type: "financial" as const })),
        ...(ocrData.extractions ?? []).map((d: { id: number; fileName: string; status: string }) => ({ ...d, type: "ocr" as const })),
      ].filter((d) => d.status === "completed");

      const alreadyAdded = new Set(
        project?.documents.map((d) => `${d.documentType}:${d.documentId}`) ?? []
      );
      setAvailableDocs(all.filter((d) => !alreadyAdded.has(`${d.type}:${d.id}`)));
    } catch { /* ignore */ } finally {
      setDocsLoading(false);
    }
  }

  async function addDocument(doc: AvailableDoc) {
    const key = `${doc.type}:${doc.id}`;
    setAddingDocId(key);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentType: doc.type, documentId: doc.id }),
      });
      if (res.status === 409) { alert("Document already added"); return; }
      if (!res.ok) throw new Error("Failed to add document");
      setShowAddDoc(false);
      await fetchProject();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to add document");
    } finally {
      setAddingDocId(null);
    }
  }

  async function removeDocument(docId: number) {
    if (!confirm("Remove this document from the project? Its index will be deleted.")) return;
    setRemovingDocId(docId);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/documents/${docId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove");
      await fetchProject();
    } catch {
      alert("Failed to remove document");
    } finally {
      setRemovingDocId(null);
    }
  }

  async function reindexDocument(docId: number) {
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/documents/${docId}/reindex`, { method: "POST" });
      await fetchProject();
    } catch { /* ignore */ }
  }

  async function askQuestion(q?: string) {
    const text = (q ?? question).trim();
    if (!text || chatLoading) return;
    setQuestion("");
    setChatLoading(true);

    const tempUserMsg: ChatMessage = {
      id: Date.now(),
      projectId,
      role: "user",
      content: text,
      sources: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      if (!res.ok) throw new Error("Chat request failed");
      const data = await res.json();
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempUserMsg.id);
        return [...withoutTemp, { ...tempUserMsg, id: tempUserMsg.id }, data.message];
      });
    } catch (e) {
      const errMsg: ChatMessage = {
        id: Date.now() + 1,
        projectId,
        role: "assistant",
        content: "Failed to get a response. Please try again.",
        sources: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setChatLoading(false);
    }
  }

  async function clearChat() {
    if (!confirm("Clear all chat history for this project?")) return;
    await fetch(`${API_BASE}/api/projects/${projectId}/chat`, { method: "DELETE" });
    setMessages([]);
  }

  function toggleSources(msgId: number) {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }

  if (isNaN(projectId)) {
    return <div className="text-center py-16 text-muted-foreground">Invalid project ID</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-3">
        <Loader2 className="size-5 animate-spin" />
        Loading project…
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-xl border border-destructive/30 bg-destructive/10 text-destructive max-w-lg mx-auto mt-8">
        <AlertCircle className="size-5 shrink-0" />
        {error ?? "Project not found"}
      </div>
    );
  }

  const indexedCount = project.documents.filter((d) => d.indexStatus === "indexed").length;
  const hasIndexed = indexedCount > 0;

  return (
    <div className="h-full flex flex-col gap-6 max-w-5xl mx-auto">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate("/projects")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ChevronLeft className="size-4" />
          All Projects
        </button>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-orange-500/10 flex items-center justify-center border border-orange-500/20">
              <HardHat className="size-5 text-orange-500" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">{project.name}</h1>
              {project.description && (
                <p className="text-sm text-muted-foreground mt-0.5">{project.description}</p>
              )}
            </div>
          </div>
          <div className="text-xs text-muted-foreground text-right">
            <div>{project.documents.length} document{project.documents.length !== 1 ? "s" : ""}</div>
            <div>{indexedCount} indexed</div>
          </div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-6 min-h-0">
        {/* Left: Documents panel */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                Project Documents
              </h2>
              <button
                onClick={() => { setShowAddDoc((v) => !v); if (!showAddDoc) loadAvailableDocs(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs font-medium"
              >
                <Plus className="size-3.5" />
                Add
              </button>
            </div>

            <AnimatePresence>
              {showAddDoc && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Available completed extractions:</p>
                    {docsLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                        <Loader2 className="size-3.5 animate-spin" />
                        Loading…
                      </div>
                    ) : availableDocs.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">No completed extractions available to add.</p>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {availableDocs.map((doc) => {
                          const meta = DOC_TYPE_META[doc.type];
                          const Icon = meta.icon;
                          const key = `${doc.type}:${doc.id}`;
                          return (
                            <button
                              key={key}
                              onClick={() => addDocument(doc)}
                              disabled={addingDocId === key}
                              className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-card border border-transparent hover:border-border transition-all text-left"
                            >
                              <Icon className={`size-3.5 ${meta.color} shrink-0`} />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-foreground truncate">{doc.fileName}</p>
                                <p className="text-xs text-muted-foreground">{meta.label}</p>
                              </div>
                              {addingDocId === key && <Loader2 className="size-3.5 animate-spin text-muted-foreground shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {project.documents.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                <FileText className="size-8 mx-auto mb-2 opacity-30" />
                <p className="text-xs">No documents yet. Add extracted specs, drawings, or financial docs to train the AI.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {project.documents.map((doc) => {
                  const meta = DOC_TYPE_META[doc.documentType as keyof typeof DOC_TYPE_META] ?? DOC_TYPE_META.ocr;
                  const status = INDEX_STATUS[doc.indexStatus] ?? INDEX_STATUS.pending;
                  const Icon = meta.icon;
                  const StatusIcon = status.icon;
                  return (
                    <div key={doc.id} className={`rounded-lg border ${meta.border} ${meta.bg} p-3`}>
                      <div className="flex items-start gap-2">
                        <Icon className={`size-4 ${meta.color} shrink-0 mt-0.5`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{doc.documentName}</p>
                          <p className="text-xs text-muted-foreground">{meta.label}</p>
                          <div className={`flex items-center gap-1 mt-1 text-xs ${status.color}`}>
                            <StatusIcon className={`size-3 ${"spin" in status && status.spin ? "animate-spin" : ""}`} />
                            {status.label}
                            {doc.indexStatus === "indexed" && <span className="text-muted-foreground">· {doc.chunkCount} chunks</span>}
                          </div>
                          {doc.errorMessage && (
                            <p className="text-xs text-destructive mt-1 truncate" title={doc.errorMessage}>{doc.errorMessage}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {doc.indexStatus === "failed" && (
                            <button
                              onClick={() => reindexDocument(doc.id)}
                              className="size-6 rounded flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              title="Retry indexing"
                            >
                              <RefreshCw className="size-3" />
                            </button>
                          )}
                          <button
                            onClick={() => removeDocument(doc.id)}
                            disabled={removingDocId === doc.id}
                            className="size-6 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            {removingDocId === doc.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {!hasIndexed && project.documents.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
              <Clock className="size-3.5 mt-0.5 shrink-0" />
              Documents are being indexed. Chat will be available once indexing is complete.
            </div>
          )}
        </div>

        {/* Right: Chat panel */}
        <div className="lg:col-span-3 flex flex-col rounded-xl border border-border bg-card overflow-hidden min-h-0">
          {/* Chat header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-primary" />
              <span className="text-sm font-semibold">Project Assistant</span>
              {hasIndexed && (
                <span className="text-xs text-emerald-500 flex items-center gap-1">
                  <CheckCircle2 className="size-3" />
                  Ready
                </span>
              )}
            </div>
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors"
              >
                Clear history
              </button>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
            {messages.length === 0 && (
              <div className="space-y-4">
                <div className="text-center py-6">
                  <div className="size-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <Sparkles className="size-6 text-primary" />
                  </div>
                  <p className="font-medium text-foreground text-sm">Ask anything about this project</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                    {hasIndexed
                      ? "The AI will answer only from indexed project documents — no guessing, no hallucinations."
                      : "Add and index documents first to start asking questions."}
                  </p>
                </div>
                {hasIndexed && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground text-center">Try asking:</p>
                    <div className="flex flex-wrap gap-2 justify-center">
                      {SUGGESTED_QUESTIONS.map((q) => (
                        <button
                          key={q}
                          onClick={() => askQuestion(q)}
                          className="text-xs px-3 py-1.5 rounded-full border border-border hover:border-primary/50 hover:bg-primary/5 text-muted-foreground hover:text-foreground transition-all"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <AnimatePresence initial={false}>
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  <div className={`size-7 rounded-full flex items-center justify-center shrink-0 ${msg.role === "user" ? "bg-primary/20" : "bg-muted"}`}>
                    {msg.role === "user" ? <User className="size-3.5 text-primary" /> : <Bot className="size-3.5 text-muted-foreground" />}
                  </div>
                  <div className={`flex-1 max-w-[85%] space-y-2 ${msg.role === "user" ? "items-end" : "items-start"} flex flex-col`}>
                    <div className={`rounded-2xl px-4 py-3 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-muted text-foreground rounded-tl-sm"}`}>
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                    </div>

                    {msg.role === "assistant" && msg.sources && msg.sources.length > 0 && (
                      <div className="w-full">
                        <button
                          onClick={() => toggleSources(msg.id)}
                          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <FileText className="size-3" />
                          {msg.sources.length} source{msg.sources.length !== 1 ? "s" : ""}
                          {expandedSources.has(msg.id) ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                        </button>
                        <AnimatePresence>
                          {expandedSources.has(msg.id) && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              className="overflow-hidden mt-2 space-y-2"
                            >
                              {msg.sources.map((src, i) => {
                                const meta = DOC_TYPE_META[src.documentType as keyof typeof DOC_TYPE_META] ?? DOC_TYPE_META.ocr;
                                const Icon = meta.icon;
                                return (
                                  <div key={i} className={`rounded-lg border ${meta.border} ${meta.bg} p-2.5 space-y-1`}>
                                    <div className="flex items-center gap-1.5">
                                      <Icon className={`size-3 ${meta.color}`} />
                                      <span className="text-xs font-medium text-foreground truncate">{src.documentName}</span>
                                    </div>
                                    {src.sectionLabel && (
                                      <p className="text-xs text-muted-foreground">{src.sectionLabel}</p>
                                    )}
                                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{src.excerpt}</p>
                                  </div>
                                );
                              })}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {chatLoading && (
              <div className="flex gap-3">
                <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Bot className="size-3.5 text-muted-foreground" />
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* Chat input */}
          <div className="border-t border-border p-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askQuestion(); } }}
                placeholder={hasIndexed ? "Ask a question about this project…" : "Add and index documents to start…"}
                disabled={!hasIndexed || chatLoading}
                className="flex-1 px-4 py-2.5 rounded-xl border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              />
              <button
                onClick={() => askQuestion()}
                disabled={!question.trim() || !hasIndexed || chatLoading}
                className="px-4 py-2.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2 text-sm font-medium"
              >
                {chatLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Answers are grounded in indexed project documents only.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
