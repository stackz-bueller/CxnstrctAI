import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  FileText,
  HardHat,
  BookOpen,
  ScanLine,
  Loader2,
  CheckCircle2,
  ChevronRight,
  Sparkles,
  AlertCircle,
  Receipt,
} from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type DetectedType = "construction_pdf" | "spec_pdf" | "scanned_pdf" | "image" | "change_order" | "invoice" | "receipt";

type SmartUploadResult = {
  detectedType: DetectedType;
  pipeline: "pdf-extractions" | "spec-extractions" | "extractions" | "financial-extractions";
  id: number | null;
  reason: string;
  pages: number | null;
  pageSize: string | null;
  avgWordsPerPage: number | null;
};

const TYPE_META: Record<DetectedType, { label: string; icon: typeof HardHat; color: string; route: (id: number) => string }> = {
  construction_pdf: {
    label: "Construction Drawing PDF",
    icon: HardHat,
    color: "text-amber-500",
    route: (id) => `/pdf-extract?id=${id}`,
  },
  spec_pdf: {
    label: "Specification PDF",
    icon: BookOpen,
    color: "text-violet-500",
    route: (id) => `/spec-extract?id=${id}`,
  },
  scanned_pdf: {
    label: "Scanned PDF (treated as drawing)",
    icon: HardHat,
    color: "text-amber-500",
    route: (id) => `/pdf-extract?id=${id}`,
  },
  image: {
    label: "Image File",
    icon: ScanLine,
    color: "text-blue-500",
    route: () => `/extract`,
  },
  change_order: {
    label: "Change Order / PCO",
    icon: Receipt,
    color: "text-amber-400",
    route: (id) => `/financial-extract?id=${id}`,
  },
  invoice: {
    label: "Supplier Invoice",
    icon: Receipt,
    color: "text-teal-400",
    route: (id) => `/financial-extract?id=${id}`,
  },
  receipt: {
    label: "Receipt",
    icon: Receipt,
    color: "text-green-400",
    route: (id) => `/financial-extract?id=${id}`,
  },
};

function FileTypeCard({ type, reason, pages, pageSize, avgWordsPerPage }: {
  type: DetectedType;
  reason: string;
  pages: number | null;
  pageSize: string | null;
  avgWordsPerPage: number | null;
}) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      className="rounded-2xl border border-border bg-card p-6 space-y-4"
    >
      <div className="flex items-center gap-3">
        <div className={`size-12 rounded-xl bg-muted flex items-center justify-center border border-border`}>
          <Icon className={`size-6 ${meta.color}`} />
        </div>
        <div>
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Detected Type</p>
          <p className={`text-lg font-bold ${meta.color}`}>{meta.label}</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground bg-muted/40 rounded-lg px-4 py-2.5 border border-border/40">
        {reason}
      </p>
      <div className="flex flex-wrap gap-3">
        {pages != null && (
          <div className="text-xs font-medium text-muted-foreground bg-muted/50 rounded-lg px-3 py-1.5 border border-border/40">
            {pages} pages
          </div>
        )}
        {pageSize && (
          <div className="text-xs font-medium text-muted-foreground bg-muted/50 rounded-lg px-3 py-1.5 border border-border/40">
            {pageSize}
          </div>
        )}
        {avgWordsPerPage != null && (
          <div className="text-xs font-medium text-muted-foreground bg-muted/50 rounded-lg px-3 py-1.5 border border-border/40">
            ~{avgWordsPerPage} words/page
          </div>
        )}
      </div>
    </motion.div>
  );
}

type Phase = "idle" | "detecting" | "uploading" | "done" | "error";

export default function SmartUploadPage() {
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [fileName, setFileName] = useState<string>("");
  const [result, setResult] = useState<SmartUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setResult(null);
    setError(null);
    setPhase("detecting");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_BASE}/api/smart-upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Detection failed");
      }

      const data: SmartUploadResult = await res.json();
      setResult(data);

      // Images: redirect immediately to extract page
      if (data.detectedType === "image") {
        setPhase("done");
        setTimeout(() => navigate("/extract"), 1200);
        return;
      }

      // PDFs: processing has already started in the background
      setPhase("done");

      // Navigate to the result page after a brief moment
      setTimeout(() => {
        const meta = TYPE_META[data.detectedType];
        if (data.id != null) {
          navigate(meta.route(data.id));
        }
      }, 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setPhase("error");
    }
  }, [navigate]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles[0]) handleFile(acceptedFiles[0]);
  }, [handleFile]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    disabled: phase === "detecting" || phase === "uploading" || phase === "done",
    accept: {
      "application/pdf": [".pdf"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"],
    },
  });

  const isLoading = phase === "detecting" || phase === "uploading";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-2xl mx-auto space-y-8"
    >
      {/* Header */}
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-sm font-semibold text-primary">
          <Sparkles className="size-4" />
          Smart Auto-Detection
        </div>
        <h1 className="text-4xl font-display font-bold text-foreground">
          Drop any document
        </h1>
        <p className="text-lg text-muted-foreground">
          The system automatically identifies whether it's a construction drawing, specification, financial document, or image — then routes it to the right pipeline.
        </p>
      </div>

      {/* Supported types legend */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { icon: HardHat, label: "Construction PDF", desc: "Large-format drawings", color: "text-amber-500" },
          { icon: BookOpen, label: "Specification PDF", desc: "CSI-format specs", color: "text-violet-500" },
          { icon: Receipt, label: "Change Orders / Invoices", desc: "PCOs, invoices, receipts", color: "text-teal-400" },
          { icon: ScanLine, label: "Image / Photo", desc: "JPG, PNG, WebP", color: "text-blue-500" },
        ].map(({ icon: Icon, label, desc, color }) => (
          <div key={label} className="bg-card rounded-xl border border-border p-4 text-center space-y-2">
            <Icon className={`size-6 mx-auto ${color}`} />
            <p className="text-xs font-semibold text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        ))}
      </div>

      {/* Dropzone */}
      <div
        {...getRootProps()}
        className={`
          relative border-2 border-dashed rounded-2xl p-14 text-center cursor-pointer transition-all duration-200
          ${isDragActive ? "border-primary bg-primary/5 scale-[1.01]" : "border-border bg-card hover:border-primary/60 hover:bg-muted/20"}
          ${isLoading || phase === "done" ? "opacity-70 pointer-events-none" : ""}
        `}
      >
        <input {...getInputProps()} />
        <div className="flex flex-col items-center gap-4">
          <AnimatePresence mode="wait">
            {phase === "idle" && (
              <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-4">
                <div className="size-20 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Upload className="size-10 text-primary" />
                </div>
                <div>
                  <p className="text-xl font-bold text-foreground">
                    {isDragActive ? "Release to analyze" : "Drop your file here"}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">PDF, JPG, PNG, WebP accepted</p>
                </div>
                <div className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold">
                  Select file
                </div>
              </motion.div>
            )}

            {phase === "detecting" && (
              <motion.div key="detecting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-4">
                <Loader2 className="size-14 text-primary animate-spin" />
                <div>
                  <p className="text-xl font-bold text-foreground">Analyzing document…</p>
                  <p className="text-sm text-muted-foreground mt-1 font-mono truncate max-w-sm">{fileName}</p>
                </div>
              </motion.div>
            )}

            {phase === "done" && result && (
              <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3">
                <CheckCircle2 className="size-14 text-green-500" />
                <p className="text-xl font-bold text-foreground">Detected — routing…</p>
                <p className="text-sm text-muted-foreground">{TYPE_META[result.detectedType].label}</p>
              </motion.div>
            )}

            {phase === "error" && (
              <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-4">
                <AlertCircle className="size-14 text-destructive" />
                <div>
                  <p className="text-xl font-bold text-foreground">Could not process file</p>
                  <p className="text-sm text-destructive mt-1">{error}</p>
                </div>
                <div className="px-5 py-2.5 rounded-xl bg-muted border border-border text-sm font-semibold">
                  Try another file
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Detection result card */}
      <AnimatePresence>
        {result && (
          <div className="space-y-4">
            <FileTypeCard
              type={result.detectedType}
              reason={result.reason}
              pages={result.pages}
              pageSize={result.pageSize}
              avgWordsPerPage={result.avgWordsPerPage}
            />
            {result.detectedType !== "image" && result.id != null && (
              <motion.button
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                onClick={() => {
                  const meta = TYPE_META[result.detectedType];
                  navigate(meta.route(result.id!));
                }}
                className="w-full flex items-center justify-between px-6 py-4 rounded-2xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <FileText className="size-5" />
                  View extraction result
                </div>
                <ChevronRight className="size-5" />
              </motion.button>
            )}
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
