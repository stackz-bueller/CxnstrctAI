import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";
import {
  FileText,
  Upload,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock,
  XCircle,
  Loader2,
  BookOpen,
  Layers,
  Hash,
} from "lucide-react";
import {
  useListSpecExtractions,
  useGetSpecExtraction,
  SpecExtractionDetail,
  SpecExtractionSummary,
  SpecSection,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

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

// ─── Upload zone ──────────────────────────────────────────────────────────────

function SpecDropzone({ onUploaded }: { onUploaded: (id: number) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_BASE}/api/spec-extractions/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text() || "Upload failed");
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/spec-extractions"] });
      onUploaded(data.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [queryClient, onUploaded]);

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
            {uploading ? "Uploading specification…" : isDragActive ? "Drop the PDF here" : "Drop a specification PDF"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            CSI-format technical specifications, project manuals, contract documents
          </p>
        </div>
        {!uploading && (
          <div className="px-4 py-2 rounded-lg bg-primary/10 border border-primary/20 text-sm text-primary font-medium">
            Select PDF file
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 px-4 py-2 rounded-lg border border-destructive/20">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Section card ─────────────────────────────────────────────────────────────

function SectionCard({ section }: { section: SpecSection }) {
  const [open, setOpen] = useState(false);
  const totalSubs = section.parts.reduce((n, p) => n + p.subsections.length, 0);

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <div className="px-2.5 py-1 rounded-lg bg-primary/10 border border-primary/20 text-xs font-mono font-bold text-primary shrink-0">
            {section.section_number}
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{section.section_title}</p>
            <p className="text-xs text-muted-foreground">
              {section.division_title} · pp. {section.page_start}–{section.page_end} · {section.parts.length} parts · {totalSubs} subsections
            </p>
          </div>
        </div>
        {open ? <ChevronDown className="size-4 text-muted-foreground shrink-0" /> : <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 divide-y divide-border/30">
              {section.parts.map((part, pi) => (
                <div key={pi} className="px-5 py-4">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Layers className="size-3.5" />
                    {part.name}
                  </h4>
                  <div className="space-y-3">
                    {part.subsections.map((sub, si) => (
                      <div key={si} className="bg-muted/30 rounded-lg px-4 py-3 border border-border/40">
                        <div className="flex items-baseline gap-2 mb-1">
                          {sub.identifier && (
                            <span className="font-mono text-xs text-primary font-bold shrink-0">
                              {sub.identifier}
                            </span>
                          )}
                          {sub.title && (
                            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
                              {sub.title}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                          {sub.content}
                        </p>
                      </div>
                    ))}
                    {part.subsections.length === 0 && (
                      <p className="text-xs text-muted-foreground italic">No subsections parsed</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Division group ───────────────────────────────────────────────────────────

function DivisionGroup({
  divNumber,
  divTitle,
  sections,
}: {
  divNumber: string;
  divTitle: string;
  sections: SpecSection[];
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 text-left group"
      >
        <div className="h-px flex-1 bg-border/60" />
        <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap group-hover:text-foreground transition-colors">
          <Hash className="size-3" />
          Division {divNumber} — {divTitle}
          <span className="text-primary/70">({sections.length})</span>
        </div>
        <div className="h-px flex-1 bg-border/60" />
        {open ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden space-y-2 pl-0"
          >
            {sections.map((s) => (
              <SectionCard key={s.section_number} section={s} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Extraction detail ────────────────────────────────────────────────────────

function ExtractionDetail({ id }: { id: number }) {
  const { data, isLoading } = useGetSpecExtraction(id, {
    query: {
      refetchInterval: (q) => {
        const status = (q.state.data as SpecExtractionDetail | undefined)?.status;
        return status === "processing" ? 4000 : false;
      },
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-8 text-primary animate-spin" />
      </div>
    );
  }
  if (!data) return null;

  // Group sections by division
  const sections = (data.sections as SpecSection[]) || [];
  const byDivision: Record<string, { title: string; sections: SpecSection[] }> = {};
  for (const s of sections) {
    if (!byDivision[s.division_number]) {
      byDivision[s.division_number] = { title: s.division_title, sections: [] };
    }
    byDivision[s.division_number].sections.push(s);
  }

  const totalSubs = sections.reduce(
    (n, s) => n + s.parts.reduce((m, p) => m + p.subsections.length, 0),
    0
  );

  return (
    <motion.div key={id} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-foreground">{data.projectName || data.fileName}</h2>
          {data.projectName && (
            <p className="text-xs font-mono text-muted-foreground mt-0.5">{data.fileName}</p>
          )}
          <p className="text-sm text-muted-foreground mt-1">
            {data.totalPages} pages · {sections.length} sections · {totalSubs} subsections ·{" "}
            {data.processingTimeMs > 0 ? `${(data.processingTimeMs / 1000).toFixed(0)}s` : "—"}
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {data.status === "failed" && (
        <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive">
          {data.errorMessage || "Processing failed."}
        </div>
      )}

      {data.status === "processing" && (
        <div className="p-6 rounded-xl bg-blue-500/5 border border-blue-500/20 text-center">
          <Loader2 className="size-8 text-blue-500 animate-spin mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground">Extracting specification sections…</p>
          <p className="text-xs text-muted-foreground mt-1">
            Parsing CSI structure and structuring requirements with AI. Takes 1–3 minutes.
          </p>
        </div>
      )}

      {data.status === "completed" && sections.length > 0 && (
        <div className="space-y-5">
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Divisions", value: Object.keys(byDivision).length, icon: BookOpen },
              { label: "Sections", value: sections.length, icon: FileText },
              { label: "Subsections", value: totalSubs, icon: Layers },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="bg-card rounded-xl border border-border p-4 text-center">
                <Icon className="size-5 text-primary mx-auto mb-2" />
                <p className="text-2xl font-bold text-foreground">{value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Sections grouped by division */}
          <div className="space-y-6">
            {Object.entries(byDivision)
              .sort(([a], [b]) => parseInt(a) - parseInt(b))
              .map(([divNum, { title, sections: divSections }]) => (
                <DivisionGroup
                  key={divNum}
                  divNumber={divNum}
                  divTitle={title}
                  sections={divSections}
                />
              ))}
          </div>
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
  const { data, isLoading } = useListSpecExtractions({
    query: { refetchInterval: 5000 },
  });
  const items: SpecExtractionSummary[] = data?.extractions ?? [];

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
        <p className="text-sm">No specs processed yet</p>
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
            <span className="text-sm font-medium text-foreground truncate">
              {item.projectName || item.fileName}
            </span>
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

export default function SpecExtractPage() {
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-7xl mx-auto space-y-6"
    >
      <div>
        <h1 className="text-3xl font-display font-bold flex items-center gap-3">
          <BookOpen className="size-8 text-primary" />
          Specification Extraction
        </h1>
        <p className="text-muted-foreground mt-2">
          Upload CSI-format specification PDFs. Text is extracted directly (no OCR) and parsed into
          divisions, sections, and requirements.
        </p>
      </div>

      <SpecDropzone onUploaded={(id) => setSelectedId(id)} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Recent Specs</h3>
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
                <BookOpen className="size-12 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground">Select a processed specification to browse its sections</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
