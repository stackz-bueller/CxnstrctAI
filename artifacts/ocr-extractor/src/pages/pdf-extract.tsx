import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";
import {
  HardHat,
  Upload,
  FileText,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock,
  XCircle,
  Loader2,
  Layers,
  BookOpen,
  Megaphone,
  Tag,
} from "lucide-react";
import {
  useListPdfExtractions,
  useGetPdfExtraction,
  PdfExtractionDetail,
  PdfExtractionSummary,
  ConstructionPageResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Upload zone ──────────────────────────────────────────────────────────────

function PdfDropzone({ onUploaded }: { onUploaded: (id: number) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      setUploading(true);
      setError(null);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`${API_BASE}/api/pdf-extractions/upload`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Upload failed");
        }
        const data = await res.json();
        queryClient.invalidateQueries({ queryKey: ["/api/pdf-extractions"] });
        onUploaded(data.id);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [queryClient, onUploaded]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    disabled: uploading,
  });

  return (
    <div
      {...getRootProps()}
      className={`
        border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200
        ${isDragActive ? "border-primary bg-primary/5 scale-[1.01]" : "border-border bg-card hover:border-primary/60 hover:bg-muted/30"}
        ${uploading ? "opacity-60 pointer-events-none" : ""}
      `}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-4">
        {uploading ? (
          <Loader2 className="size-12 text-primary animate-spin" />
        ) : (
          <div className="size-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Upload className="size-8 text-primary" />
          </div>
        )}
        <div>
          <p className="text-lg font-semibold text-foreground">
            {uploading ? "Uploading PDF…" : isDragActive ? "Drop the PDF here" : "Drop a construction PDF"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            {uploading
              ? "This may take a moment for large files"
              : "Architectural drawings, engineering sheets, construction documents"}
          </p>
        </div>
        {!uploading && (
          <div className="px-4 py-2 rounded-lg bg-primary/10 border border-primary/20 text-sm text-primary font-medium">
            Select PDF file
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive mt-2 bg-destructive/10 px-4 py-2 rounded-lg border border-destructive/20">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "completed")
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-500/10 text-green-600 border border-green-500/20">
        <CheckCircle2 className="size-3.5" /> Completed
      </span>
    );
  if (status === "processing")
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-600 border border-blue-500/20">
        <Loader2 className="size-3.5 animate-spin" /> Processing
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-destructive/10 text-destructive border border-destructive/20">
      <XCircle className="size-3.5" /> Failed
    </span>
  );
}

// ─── Page result detail ───────────────────────────────────────────────────────

function PageResultCard({ page }: { page: ConstructionPageResult }) {
  const [open, setOpen] = useState(false);
  const tb = page.title_block;
  const hasTitleBlock = tb && Object.entries(tb).some(([k, v]) => k !== "confidence" && v);

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <div className={`size-8 rounded-lg flex items-center justify-center text-sm font-bold ${
            (page as Record<string, unknown>).voided
              ? "bg-red-500/20 border border-red-500/40 text-red-400"
              : "bg-primary/10 border border-primary/20 text-primary"
          }`}>
            {(page as Record<string, unknown>).voided ? "X" : page.page_number}
          </div>
          <div>
            <p className={`text-sm font-semibold ${(page as Record<string, unknown>).voided ? "text-red-400 line-through" : "text-foreground"}`}>
              {(page as Record<string, unknown>).voided ? "[VOIDED] " : ""}
              {tb?.drawing_title || tb?.sheet_number || `Page ${page.page_number}`}
            </p>
            <p className="text-xs text-muted-foreground">
              {(page as Record<string, unknown>).voided
                ? `Removed from project: ${(page as Record<string, unknown>).voided_reason || "Page crossed out"}`
                : `OCR confidence: ${Math.round((page.ocr_confidence ?? 0) * 100)}% · ${page.callouts.length} callouts · ${page.general_notes.length} notes`
              }
            </p>
          </div>
        </div>
        {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 border-t border-border/50 space-y-5 pt-4">

              {/* Title Block */}
              {hasTitleBlock && (
                <section>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Tag className="size-3.5" /> Title Block
                    <span className="ml-auto text-foreground font-mono">
                      {Math.round((tb?.confidence ?? 0) * 100)}% conf.
                    </span>
                  </h4>
                  <dl className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {[
                      ["Project", tb?.project_name],
                      ["Drawing Title", tb?.drawing_title],
                      ["Sheet No.", tb?.sheet_number],
                      ["Revision", tb?.revision],
                      ["Date", tb?.date],
                      ["Drawn By", tb?.drawn_by],
                      ["Scale", tb?.scale],
                    ].map(([label, value]) =>
                      value ? (
                        <div key={label as string} className="bg-muted/40 rounded-lg p-3 border border-border/50">
                          <dt className="text-xs text-muted-foreground mb-1">{label as string}</dt>
                          <dd className="text-sm font-medium font-mono text-foreground">{value as string}</dd>
                        </div>
                      ) : null
                    )}
                  </dl>
                </section>
              )}

              {/* Revision History */}
              {page.revision_history.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Clock className="size-3.5" /> Revision History
                  </h4>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="text-left pb-2 font-medium">Rev</th>
                        <th className="text-left pb-2 font-medium">Date</th>
                        <th className="text-left pb-2 font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {page.revision_history.map((rev, i) => (
                        <tr key={i}>
                          <td className="py-2 font-mono text-xs pr-4">{rev.rev_number ?? "—"}</td>
                          <td className="py-2 text-xs pr-4">{rev.date ?? "—"}</td>
                          <td className="py-2 text-xs text-muted-foreground">{rev.description ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {/* General Notes */}
              {page.general_notes.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                    <BookOpen className="size-3.5" /> General Notes
                  </h4>
                  <ol className="space-y-2 list-decimal list-inside">
                    {page.general_notes.map((note, i) => (
                      <li key={i} className="text-sm text-foreground bg-muted/30 rounded-lg px-3 py-2 border border-border/50">
                        {note}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {/* Callouts & Legends side by side */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {page.callouts.length > 0 && (
                  <section>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Megaphone className="size-3.5" /> Callouts
                    </h4>
                    <div className="space-y-1.5">
                      {page.callouts.map((c, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          <span className="px-1.5 py-0.5 rounded text-xs bg-amber-500/10 text-amber-600 border border-amber-500/20 font-mono shrink-0">
                            {c.type}
                          </span>
                          <span className="text-foreground">{c.text}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {page.legends.length > 0 && (
                  <section>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Layers className="size-3.5" /> Legend
                    </h4>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="text-left pb-2 font-medium">Symbol</th>
                          <th className="text-left pb-2 font-medium">Meaning</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {page.legends.map((leg, i) => (
                          <tr key={i}>
                            <td className="py-1.5 font-mono text-xs pr-4">{leg.symbol}</td>
                            <td className="py-1.5 text-xs text-muted-foreground">{leg.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )}
              </div>

              {/* Full extracted text */}
              {page.all_text && (
                <section>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                    Full Extracted Text
                  </h4>
                  <pre className="text-xs font-mono bg-muted/40 rounded-xl p-4 border border-border/50 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
                    {page.all_text}
                  </pre>
                </section>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Extraction detail panel ──────────────────────────────────────────────────

function ExtractionDetail({ id }: { id: number }) {
  const { data, isLoading } = useGetPdfExtraction(id, {
    query: {
      refetchInterval: (q) => {
        const status = (q.state.data as PdfExtractionDetail | undefined)?.status;
        return status === "processing" ? 3000 : false;
      },
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      className="space-y-5"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-foreground">{data.fileName}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data.totalPages} page{data.totalPages !== 1 ? "s" : ""} ·{" "}
            {data.processingTimeMs > 0 ? `${(data.processingTimeMs / 1000).toFixed(1)}s` : "—"}
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {data.status === "failed" && (
        <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive">
          {data.errorMessage || "Processing failed with an unknown error."}
        </div>
      )}

      {data.status === "processing" && (
        <div className="p-6 rounded-xl bg-blue-500/5 border border-blue-500/20 text-center">
          <Loader2 className="size-8 text-blue-500 animate-spin mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground">Processing your document…</p>
          <p className="text-xs text-muted-foreground mt-1">
            Running OCR + GPT-4o Vision on each page. This can take 1–3 minutes.
          </p>
        </div>
      )}

      {data.status === "completed" && data.pages && (
        <div className="space-y-3">
          {(data.pages as ConstructionPageResult[]).map((page) => (
            <PageResultCard key={page.page_number} page={page} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ─── History list ─────────────────────────────────────────────────────────────

function ExtractionsList({
  selectedId,
  onSelect,
}: {
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { data, isLoading } = useListPdfExtractions({
    query: { refetchInterval: 5000 },
  });
  const items: PdfExtractionSummary[] = data?.extractions ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded-xl" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileText className="size-10 mx-auto mb-3 opacity-20" />
        <p className="text-sm">No PDFs processed yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {[...items].reverse().map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item.id)}
          className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-150 ${
            selectedId === item.id
              ? "border-primary bg-primary/5"
              : "border-border bg-card hover:bg-muted/30"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground truncate">{item.fileName}</span>
            <StatusBadge status={item.status} />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {format(new Date(item.createdAt), "MMM d, HH:mm")} · {item.totalPages}p
          </p>
        </button>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PdfExtractPage() {
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    return id ? parseInt(id, 10) : null;
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) setSelectedId(parseInt(id, 10));
  }, []);

  function handleUploaded(id: number) {
    setSelectedId(id);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-7xl mx-auto space-y-6"
    >
      <div>
        <h1 className="text-3xl font-display font-bold flex items-center gap-3">
          <HardHat className="size-8 text-primary" />
          Construction PDF Extraction
        </h1>
        <p className="text-muted-foreground mt-2">
          Upload construction drawings and engineering documents. The pipeline runs regional OCR +
          GPT-4o Vision tiling for maximum coverage.
        </p>
      </div>

      <PdfDropzone onUploaded={handleUploaded} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Recent PDFs</h3>
          <ExtractionsList selectedId={selectedId} onSelect={setSelectedId} />
        </Card>

        <div className="lg:col-span-2">
          {selectedId ? (
            <Card className="p-6">
              <ExtractionDetail id={selectedId} />
            </Card>
          ) : (
            <div className="flex items-center justify-center h-full min-h-[300px] border-2 border-dashed border-border rounded-2xl text-center p-8">
              <div>
                <HardHat className="size-12 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground">Select a processed PDF to view its extraction results</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
