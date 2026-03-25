import { useState, useEffect, useRef, useCallback, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  ThumbsUp,
  ThumbsDown,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Search,
  Edit3,
  Save,
  X,
  ArrowLeft,
  ArrowRight,
  History,
  Upload,
} from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Project = {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  documents: ProjectDocument[];
};

type ExtractionProgress = {
  status: string;
  processedPages: number;
  totalPages: number;
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
  extractionProgress?: ExtractionProgress;
};

type ChatMessage = {
  id: number;
  projectId: number;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[] | null;
  confidence?: number | null;
  feedback?: "positive" | "negative" | null;
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

type ChunkData = {
  id: number;
  chunkIndex: number;
  content: string;
  sectionLabel: string | null;
};

type ChunkPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
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

  const [activeTab, setActiveTab] = useState<"documents" | "assistant">("assistant");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [question, setQuestion] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const [showAddDoc, setShowAddDoc] = useState(false);
  const [availableDocs, setAvailableDocs] = useState<AvailableDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [addingDocId, setAddingDocId] = useState<string | null>(null);
  const [removingDocId, setRemovingDocId] = useState<number | null>(null);
  const [expandedSources, setExpandedSources] = useState<Set<number>>(new Set());

  const [pollingActive, setPollingActive] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [browsingDocId, setBrowsingDocId] = useState<number | null>(null);
  const [browsingDocName, setBrowsingDocName] = useState("");
  const [chunks, setChunks] = useState<ChunkData[]>([]);
  const [chunkPagination, setChunkPagination] = useState<ChunkPagination | null>(null);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunkSearch, setChunkSearch] = useState("");
  const [editingChunkId, setEditingChunkId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editReason, setEditReason] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}`);
      if (!res.ok) throw new Error("Project not found");
      const data = await res.json();
      setProject(data);
      const hasIndexing = data.documents?.some((d: ProjectDocument) => d.indexStatus === "indexing" || d.indexStatus === "pending");
      const hasExtracting = data.documents?.some((d: ProjectDocument) =>
        d.extractionProgress && (d.extractionProgress.status === "processing" || d.extractionProgress.status === "incomplete")
      );
      setPollingActive(hasIndexing || hasExtracting);
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
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, chatLoading]);

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

  async function reprocessAllDocuments() {
    if (!confirm("This will re-run ALL documents through the updated processing pipeline. Existing extraction data will be replaced with fresh results. This may take a while for large document sets. Continue?")) return;
    setReprocessing(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/reprocess`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to start reprocessing");
      setPollingActive(true);
      await fetchProject();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to reprocess documents");
    } finally {
      setReprocessing(false);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress(`Uploading ${file.name} (${i + 1}/${files.length})…`);

      try {
        const formData = new FormData();
        formData.append("file", file);

        const uploadRes = await fetch(`${API_BASE}/api/smart-upload`, {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({}));
          alert(`Failed to upload ${file.name}: ${(errData as { error?: string }).error || uploadRes.statusText}`);
          continue;
        }

        const result = await uploadRes.json() as {
          detectedType: string;
          pipeline: string;
          id: number | null;
        };

        if (!result.id) {
          alert(`${file.name}: Detected as ${result.detectedType} but no extraction was created. Try uploading as a specific type.`);
          continue;
        }

        const typeMap: Record<string, string> = {
          "pdf-extractions": "construction",
          "spec-extractions": "spec",
          "financial-extractions": "financial",
        };
        const docType = typeMap[result.pipeline] || "ocr";

        setUploadProgress(`Adding ${file.name} to project…`);

        const addRes = await fetch(`${API_BASE}/api/projects/${projectId}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentType: docType, documentId: result.id }),
        });

        if (!addRes.ok) {
          const errData = await addRes.json().catch(() => ({}));
          alert(`Failed to add ${file.name} to project: ${(errData as { error?: string }).error || addRes.statusText}`);
        }
      } catch (e) {
        alert(`Error uploading ${file.name}: ${e instanceof Error ? e.message : "Unknown error"}`);
      }
    }

    setUploading(false);
    setUploadProgress(null);
    setPollingActive(true);
    await fetchProject();
    if (fileInputRef.current) fileInputRef.current.value = "";
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

    const streamingMsgId = Date.now() + 1;

    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/chat?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({ question: text }),
      });
      if (!res.ok) throw new Error("Chat request failed");

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream") && res.body) {
        const streamingMsg: ChatMessage = {
          id: streamingMsgId,
          projectId,
          role: "assistant",
          content: "",
          sources: [],
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, streamingMsg]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "token") {
                accumulated += event.content;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingMsgId ? { ...m, content: accumulated } : m
                  )
                );
              } else if (event.type === "sources") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingMsgId ? { ...m, sources: event.sources } : m
                  )
                );
              } else if (event.type === "done") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingMsgId
                      ? { ...event.message, confidence: event.confidence ?? null }
                      : m
                  )
                );
              } else if (event.type === "error") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingMsgId
                      ? { ...m, content: event.error || "Failed to get a response. Please try again." }
                      : m
                  )
                );
              }
            } catch {}
          }
        }
      } else {
        const data = await res.json();
        const assistantMsg = { ...data.message, confidence: data.confidence ?? null };
        setMessages((prev) => {
          const withoutTemp = prev.filter((m) => m.id !== tempUserMsg.id);
          return [...withoutTemp, { ...tempUserMsg, id: tempUserMsg.id }, assistantMsg];
        });
      }
    } catch (e) {
      const errMsg: ChatMessage = {
        id: Date.now() + 2,
        projectId,
        role: "assistant",
        content: "Failed to get a response. Please try again.",
        sources: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => prev.filter((m) => m.id !== streamingMsgId).concat(errMsg));
    } finally {
      setChatLoading(false);
    }
  }

  async function clearChat() {
    if (!confirm("Clear all chat history for this project?")) return;
    await fetch(`${API_BASE}/api/projects/${projectId}/chat`, { method: "DELETE" });
    setMessages([]);
  }

  async function fetchChunks(docId: number, page = 1, search = "") {
    setChunksLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "15" });
      if (search) params.set("search", search);
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/documents/${docId}/chunks?${params}`);
      if (!res.ok) throw new Error("Failed to load chunks");
      const data = await res.json();
      setChunks(data.chunks);
      setChunkPagination(data.pagination);
      setBrowsingDocName(data.documentName);
    } catch { /* ignore */ } finally {
      setChunksLoading(false);
    }
  }

  function openChunkBrowser(doc: ProjectDocument) {
    setBrowsingDocId(doc.id);
    setBrowsingDocName(doc.documentName);
    setChunkSearch("");
    setEditingChunkId(null);
    fetchChunks(doc.id, 1, "");
  }

  function closeChunkBrowser() {
    setBrowsingDocId(null);
    setChunks([]);
    setChunkPagination(null);
    setEditingChunkId(null);
    setChunkSearch("");
  }

  function startEdit(chunk: ChunkData) {
    setEditingChunkId(chunk.id);
    setEditContent(chunk.content);
    setEditReason("");
  }

  function cancelEdit() {
    setEditingChunkId(null);
    setEditContent("");
    setEditReason("");
  }

  async function saveCorrection(chunkId: number) {
    if (!editContent.trim()) return;
    setSavingCorrection(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/chunks/${chunkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correctedContent: editContent, reason: editReason || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to save correction");
        return;
      }
      setChunks((prev) => prev.map((c) => c.id === chunkId ? { ...c, content: editContent } : c));
      setEditingChunkId(null);
      setEditContent("");
      setEditReason("");
    } catch {
      alert("Failed to save correction");
    } finally {
      setSavingCorrection(false);
    }
  }

  async function submitFeedback(msgId: number, feedback: "positive" | "negative") {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/chat/${msgId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      if (!res.ok) {
        console.error("Feedback submission failed:", res.status);
        return;
      }
      setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, feedback } : m));
    } catch (e) {
      console.error("Failed to submit feedback:", e);
    }
  }

  function getConfidenceDisplay(confidence: number | null | undefined) {
    if (confidence == null) return null;
    if (confidence >= 8) return { label: "High confidence", color: "text-green-600", bg: "bg-green-50 border-green-200", Icon: ShieldCheck };
    if (confidence >= 5) return { label: "Medium confidence", color: "text-amber-600", bg: "bg-amber-50 border-amber-200", Icon: Shield };
    return { label: "Low confidence", color: "text-red-600", bg: "bg-red-50 border-red-200", Icon: ShieldAlert };
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
    <div className="h-full flex flex-col max-w-full mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 shrink-0 border-b border-border h-12">
        <button
          onClick={() => navigate("/")}
          className="size-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          title="All Projects"
        >
          <ChevronLeft className="size-5" />
        </button>
        <h1 className="text-base font-semibold text-foreground truncate">{project.name}</h1>
        <div className="flex items-center gap-1 ml-auto shrink-0">
          <button
            onClick={() => setActiveTab("assistant")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${activeTab === "assistant" ? "bg-card border border-border text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Bot className="size-3.5" />
            Chat
          </button>
          <button
            onClick={() => setActiveTab("documents")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${activeTab === "documents" ? "bg-card border border-border text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <FileText className="size-3.5" />
            Docs ({project.documents.length})
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {/* ── Documents tab ── */}
        {activeTab === "documents" && (
        <div className="h-full flex flex-col gap-4 overflow-y-auto p-4">
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                Project Documents
              </h2>
              <div className="flex items-center gap-2">
                {project.documents.length > 0 && (
                  <button
                    onClick={reprocessAllDocuments}
                    disabled={reprocessing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors text-xs font-medium disabled:opacity-50"
                    title="Re-run all documents through the updated processing pipeline"
                  >
                    {reprocessing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    Reprocess
                  </button>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 transition-colors text-xs font-medium disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  Upload
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => uploadFiles(e.target.files)}
                />
                <button
                  onClick={() => { setShowAddDoc((v) => !v); if (!showAddDoc) loadAvailableDocs(); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs font-medium"
                >
                  <Plus className="size-3.5" />
                  Add
                </button>
              </div>
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

            {uploadProgress && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 text-xs font-medium">
                <Loader2 className="size-3.5 animate-spin shrink-0" />
                {uploadProgress}
              </div>
            )}

            {project.documents.length === 0 ? (
              <div
                className="text-center py-8 text-muted-foreground border-2 border-dashed border-border rounded-lg hover:border-emerald-400 hover:bg-emerald-500/5 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); uploadFiles(e.dataTransfer.files); }}
              >
                <Upload className="size-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm font-medium">Drop PDF files here or click to upload</p>
                <p className="text-xs mt-1">Construction plans, specs, and financial documents are auto-detected</p>
              </div>
            ) : (
              <div className="space-y-2">
                {project.documents.map((doc) => {
                  const meta = DOC_TYPE_META[doc.documentType as keyof typeof DOC_TYPE_META] ?? DOC_TYPE_META.ocr;
                  const status = INDEX_STATUS[doc.indexStatus] ?? INDEX_STATUS.pending;
                  const Icon = meta.icon;
                  const StatusIcon = status.icon;
                  const ep = doc.extractionProgress;
                  const isExtracting = ep && (ep.status === "processing" || ep.status === "incomplete");
                  const extractionPct = ep && ep.totalPages > 0 ? Math.round((ep.processedPages / ep.totalPages) * 100) : 0;
                  return (
                    <div key={doc.id} className={`rounded-lg border ${meta.border} ${meta.bg} p-3`}>
                      <div className="flex items-start gap-2">
                        <Icon className={`size-4 ${meta.color} shrink-0 mt-0.5`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{doc.documentName}</p>
                          <p className="text-xs text-muted-foreground">{meta.label}</p>
                          {isExtracting ? (
                            <div className="mt-1.5 space-y-1">
                              <div className="flex items-center gap-1.5 text-xs text-blue-500">
                                <Loader2 className="size-3 animate-spin" />
                                <span>Extracting pages…</span>
                                <span className="text-muted-foreground ml-auto">{ep.processedPages}/{ep.totalPages}</span>
                              </div>
                              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                <motion.div
                                  className="h-full bg-blue-500 rounded-full"
                                  initial={{ width: 0 }}
                                  animate={{ width: `${extractionPct}%` }}
                                  transition={{ duration: 0.5, ease: "easeOut" }}
                                />
                              </div>
                              <p className="text-[10px] text-muted-foreground">{extractionPct}% complete — auto-resumes if interrupted</p>
                            </div>
                          ) : (
                            <>
                              <div className={`flex items-center gap-1 mt-1 text-xs ${status.color}`}>
                                <StatusIcon className={`size-3 ${"spin" in status && status.spin ? "animate-spin" : ""}`} />
                                {status.label}
                                {doc.indexStatus === "indexed" && <span className="text-muted-foreground">· {doc.chunkCount} chunks</span>}
                                {ep && ep.status === "completed" && ep.totalPages > 0 && (
                                  <span className="text-muted-foreground">· {ep.totalPages} pages</span>
                                )}
                              </div>
                            </>
                          )}
                          {doc.errorMessage && (
                            <p className="text-xs text-destructive mt-1 truncate" title={doc.errorMessage}>{doc.errorMessage}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {doc.indexStatus === "indexed" && (
                            <button
                              onClick={() => openChunkBrowser(doc)}
                              className="size-6 rounded flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              title="Browse & correct data"
                            >
                              <Search className="size-3" />
                            </button>
                          )}
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

          <AnimatePresence>
            {browsingDocId !== null && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="rounded-xl border border-border bg-card p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <button onClick={closeChunkBrowser} className="size-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0">
                      <X className="size-4" />
                    </button>
                    <h3 className="font-semibold text-sm text-foreground truncate">
                      Data Browser
                    </h3>
                    {chunkPagination && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {chunkPagination.total} chunks
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs text-muted-foreground truncate">{browsingDocName}</p>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      value={chunkSearch}
                      onChange={(e) => setChunkSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && browsingDocId) fetchChunks(browsingDocId, 1, chunkSearch);
                      }}
                      placeholder="Search chunks (e.g. address, quantity)…"
                      className="w-full pl-8 pr-3 py-2 text-xs rounded-lg border border-border bg-muted/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
                    />
                  </div>
                  <button
                    onClick={() => browsingDocId && fetchChunks(browsingDocId, 1, chunkSearch)}
                    className="px-3 py-2 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
                  >
                    Search
                  </button>
                </div>

                {chunksLoading ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    <span className="text-xs">Loading chunks…</span>
                  </div>
                ) : chunks.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">No chunks found.</p>
                ) : (
                  <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                    {chunks.map((chunk) => (
                      <div key={chunk.id} className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{chunk.chunkIndex}</span>
                            {chunk.sectionLabel && (
                              <span className="text-[11px] text-muted-foreground truncate">{chunk.sectionLabel}</span>
                            )}
                          </div>
                          {editingChunkId !== chunk.id && (
                            <button
                              onClick={() => startEdit(chunk)}
                              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors shrink-0"
                              title="Edit this chunk"
                            >
                              <Edit3 className="size-3" />
                              Correct
                            </button>
                          )}
                        </div>

                        {editingChunkId === chunk.id ? (
                          <div className="space-y-2">
                            <textarea
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              rows={8}
                              className="w-full text-xs p-2.5 rounded-lg border border-primary/30 bg-background text-foreground focus:outline-none focus:border-primary resize-y font-mono"
                            />
                            <input
                              type="text"
                              value={editReason}
                              onChange={(e) => setEditReason(e.target.value)}
                              placeholder="Reason for correction (optional, e.g. 'OCR misread address')"
                              className="w-full text-xs px-2.5 py-2 rounded-lg border border-border bg-muted/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
                            />
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={cancelEdit}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              >
                                <X className="size-3" />
                                Cancel
                              </button>
                              <button
                                onClick={() => saveCorrection(chunk.id)}
                                disabled={savingCorrection || editContent === chunk.content}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                              >
                                {savingCorrection ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                                Save Correction
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap line-clamp-6">{chunk.content}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {chunkPagination && chunkPagination.totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <button
                      onClick={() => browsingDocId && fetchChunks(browsingDocId, chunkPagination.page - 1, chunkSearch)}
                      disabled={chunkPagination.page <= 1}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
                    >
                      <ArrowLeft className="size-3" />
                      Previous
                    </button>
                    <span className="text-xs text-muted-foreground">
                      Page {chunkPagination.page} of {chunkPagination.totalPages}
                    </span>
                    <button
                      onClick={() => browsingDocId && fetchChunks(browsingDocId, chunkPagination.page + 1, chunkSearch)}
                      disabled={chunkPagination.page >= chunkPagination.totalPages}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
                    >
                      Next
                      <ArrowRight className="size-3" />
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        )}

        {/* ── Assistant tab ── */}
        {activeTab === "assistant" && (
        <div className="h-full flex flex-col overflow-hidden min-h-0">
          {/* Messages area */}
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center px-4">
                <div className="max-w-md text-center space-y-6">
                  <div className="size-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto border border-primary/20">
                    <HardHat className="size-8 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">How can I help with {project.name}?</h2>
                    <p className="text-sm text-muted-foreground mt-2">
                      {hasIndexed
                        ? "I only answer from your indexed project documents — plans, specs, and drawings. Ask me anything."
                        : "Add and index documents first, then I can answer questions about them."}
                    </p>
                  </div>
                  {hasIndexed && (
                    <div className="grid grid-cols-2 gap-2">
                      {SUGGESTED_QUESTIONS.map((q) => (
                        <button
                          key={q}
                          onClick={() => askQuestion(q)}
                          className="text-left text-sm px-4 py-3 rounded-xl border border-border hover:border-primary/40 hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-all"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                <AnimatePresence initial={false}>
                  {messages.map((msg) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className={msg.role === "user" ? "bg-transparent" : "bg-muted/30"}
                    >
                      <div className="max-w-3xl mx-auto px-4 py-6">
                        <div className="flex gap-4">
                          <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${msg.role === "user" ? "bg-primary/15 border border-primary/25" : "bg-card border border-border"}`}>
                            {msg.role === "user" ? <User className="size-4 text-primary" /> : <Bot className="size-4 text-muted-foreground" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-semibold text-foreground">{msg.role === "user" ? "You" : "ConstructAI"}</span>
                              {msg.role === "assistant" && (() => {
                                const conf = getConfidenceDisplay(msg.confidence);
                                if (!conf) return null;
                                const ConfIcon = conf.Icon;
                                return (
                                  <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md border ${conf.bg} ${conf.color}`}>
                                    <ConfIcon className="size-2.5" />
                                    {msg.confidence}/10
                                  </span>
                                );
                              })()}
                            </div>
                            {msg.role === "assistant" ? (
                              <div className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed text-foreground/90
                                prose-p:my-2 prose-p:leading-relaxed
                                prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-headings:text-foreground
                                prose-h3:text-sm prose-h3:font-semibold
                                prose-strong:text-foreground prose-strong:font-semibold
                                prose-ul:my-2 prose-ul:pl-5 prose-ol:my-2 prose-ol:pl-5
                                prose-li:my-0.5 prose-li:leading-relaxed
                                prose-table:my-3 prose-table:text-xs prose-table:border-collapse
                                prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-th:border prose-th:border-border prose-th:bg-card prose-th:text-foreground
                                prose-td:px-3 prose-td:py-2 prose-td:border prose-td:border-border prose-td:text-muted-foreground
                                prose-hr:my-4 prose-hr:border-border
                                prose-code:text-xs prose-code:bg-card prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-code:border prose-code:border-border
                                prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                              ">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                              </div>
                            ) : (
                              <p className="text-sm text-foreground/90 leading-relaxed">{msg.content}</p>
                            )}

                            {msg.role === "assistant" && (
                              <div className="mt-3 flex items-center gap-1 border-t border-border/30 pt-3">
                                <button
                                  onClick={() => submitFeedback(msg.id, "positive")}
                                  className={`p-1.5 rounded-md transition-colors ${msg.feedback === "positive" ? "text-green-500 bg-green-500/10" : "text-muted-foreground/50 hover:text-foreground hover:bg-muted"}`}
                                  title="Good response"
                                >
                                  <ThumbsUp className="size-4" />
                                </button>
                                <button
                                  onClick={() => submitFeedback(msg.id, "negative")}
                                  className={`p-1.5 rounded-md transition-colors ${msg.feedback === "negative" ? "text-red-500 bg-red-500/10" : "text-muted-foreground/50 hover:text-foreground hover:bg-muted"}`}
                                  title="Bad response"
                                >
                                  <ThumbsDown className="size-4" />
                                </button>
                                <div className="w-px h-4 bg-border/50 mx-1" />
                                {msg.sources && msg.sources.length > 0 && (
                                  <button
                                    onClick={() => toggleSources(msg.id)}
                                    className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted transition-colors"
                                  >
                                    <FileText className="size-3.5" />
                                    {msg.sources.length} source{msg.sources.length !== 1 ? "s" : ""}
                                    {expandedSources.has(msg.id) ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                                  </button>
                                )}
                                {messages.indexOf(msg) === messages.length - 1 && messages.length > 1 && (
                                  <button
                                    onClick={clearChat}
                                    className="ml-auto text-xs text-muted-foreground/40 hover:text-destructive px-2 py-1.5 rounded-md hover:bg-destructive/10 transition-colors"
                                  >
                                    Clear chat
                                  </button>
                                )}
                              </div>
                            )}

                            {msg.role === "assistant" && msg.sources && expandedSources.has(msg.id) && (
                              <AnimatePresence>
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: "auto" }}
                                  exit={{ opacity: 0, height: 0 }}
                                  className="overflow-hidden mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2"
                                >
                                  {msg.sources.map((src, i) => {
                                    const meta = DOC_TYPE_META[src.documentType as keyof typeof DOC_TYPE_META] ?? DOC_TYPE_META.ocr;
                                    const Icon = meta.icon;
                                    return (
                                      <div key={i} className="rounded-lg border border-border bg-card/50 p-2.5 space-y-1">
                                        <div className="flex items-center gap-1.5">
                                          <Icon className={`size-3 ${meta.color}`} />
                                          <span className="text-xs font-medium text-foreground truncate">{src.documentName}</span>
                                        </div>
                                        {src.sectionLabel && (
                                          <p className="text-[11px] text-muted-foreground">{src.sectionLabel}</p>
                                        )}
                                        <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{src.excerpt}</p>
                                      </div>
                                    );
                                  })}
                                </motion.div>
                              </AnimatePresence>
                            )}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>

                {chatLoading && (
                  <div className="bg-muted/30">
                    <div className="max-w-3xl mx-auto px-4 py-6">
                      <div className="flex gap-4">
                        <div className="size-8 rounded-lg bg-card border border-border flex items-center justify-center shrink-0">
                          <Bot className="size-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1">
                          <span className="text-sm font-semibold text-foreground block mb-2">ConstructAI</span>
                          <div className="flex items-center gap-1">
                            <div className="size-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0ms" }} />
                            <div className="size-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "150ms" }} />
                            <div className="size-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "300ms" }} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* Chat input — pinned bottom */}
          <div className="border-t border-border bg-background">
            <div className="max-w-3xl mx-auto px-4 py-4">
              <div className="relative flex items-end rounded-2xl border border-border bg-card shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20 transition-all">
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askQuestion(); } }}
                  placeholder={hasIndexed ? "Message ConstructAI…" : "Index documents to start chatting…"}
                  disabled={!hasIndexed || chatLoading}
                  className="flex-1 bg-transparent pl-4 pr-12 py-3.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50"
                />
                <button
                  onClick={() => askQuestion()}
                  disabled={!question.trim() || !hasIndexed || chatLoading}
                  className="absolute right-2 bottom-2 size-8 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:hover:bg-primary transition-colors flex items-center justify-center"
                >
                  {chatLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground/50 mt-2 text-center">
                ConstructAI answers only from indexed project documents. Always verify critical values.
              </p>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
