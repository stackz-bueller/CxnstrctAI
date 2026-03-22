import React, { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import {
  Receipt,
  Upload,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
} from "lucide-react";
const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ──────────────────────────────────────────────────────────────────────

interface LineItem {
  description: string;
  quantity?: string | null;
  unit?: string | null;
  unit_price?: string | null;
  extension?: string | null;
  trade?: string | null;
  hours?: string | null;
  rate?: string | null;
  part_number?: string | null;
}

interface FinancialDocument {
  type: "change_order" | "invoice" | "receipt" | "other";
  page_start: number;
  page_end: number;
  fields: Record<string, unknown>;
  line_items: LineItem[];
  totals: Record<string, unknown>;
  raw_text?: string;
}

interface Extraction {
  id: number;
  fileName: string;
  status: "processing" | "completed" | "failed";
  totalPages: number;
  detectedType?: string | null;
  processingTimeMs: number;
  errorMessage?: string | null;
  createdAt: string;
  documents?: FinancialDocument[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<string, string> = {
  change_order: "Change Order / PCO",
  invoice: "Supplier Invoice",
  receipt: "Receipt",
  other: "Financial Document",
};

const DOC_TYPE_COLORS: Record<string, string> = {
  change_order: "text-amber-400 bg-amber-400/10 border-amber-400/30",
  invoice: "text-blue-400 bg-blue-400/10 border-blue-400/30",
  receipt: "text-green-400 bg-green-400/10 border-green-400/30",
  other: "text-gray-400 bg-gray-400/10 border-gray-400/30",
};

function fmt(val: unknown): string {
  if (val === null || val === undefined || val === "") return "—";
  if (typeof val === "object") {
    // Flatten nested address/name objects into a readable string
    const entries = Object.entries(val as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([, v]) => String(v));
    return entries.join(", ") || "—";
  }
  return String(val);
}

function fmtTime(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Line-items table ──────────────────────────────────────────────────────────

function LineItemsTable({ items, docType }: { items: LineItem[]; docType: string }) {
  if (!items.length) return null;

  const isChangeOrder = docType === "change_order";

  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-xs text-gray-400 uppercase tracking-wide">
          <tr>
            {isChangeOrder ? (
              <>
                <th className="px-3 py-2 text-left">Trade / Description</th>
                <th className="px-3 py-2 text-right">Hours</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Unit</th>
                <th className="px-3 py-2 text-right">Extension</th>
              </>
            ) : (
              <>
                <th className="px-3 py-2 text-left">Part #</th>
                <th className="px-3 py-2 text-left">Description</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-left">Unit</th>
                <th className="px-3 py-2 text-right">Unit Price</th>
                <th className="px-3 py-2 text-right">Extension</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {items.map((item, i) => (
            <tr key={i} className="hover:bg-white/5 transition-colors">
              {isChangeOrder ? (
                <>
                  <td className="px-3 py-2 text-gray-200">{fmt(item.trade || item.description)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmt(item.hours)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmt(item.rate)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmt(item.quantity)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmt(item.unit)}</td>
                  <td className="px-3 py-2 text-right font-medium text-teal-300">{fmt(item.extension)}</td>
                </>
              ) : (
                <>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400">{fmt(item.part_number)}</td>
                  <td className="px-3 py-2 text-gray-200">{fmt(item.description)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmt(item.quantity)}</td>
                  <td className="px-3 py-2 text-gray-300">{fmt(item.unit)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmt(item.unit_price)}</td>
                  <td className="px-3 py-2 text-right font-medium text-teal-300">{fmt(item.extension)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Totals display ────────────────────────────────────────────────────────────

function TotalsGrid({ totals }: { totals: Record<string, unknown> }) {
  const entries = Object.entries(totals).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!entries.length) return null;

  // Identify the "grand total" key (largest amount or key with "total" in it)
  const isGrandTotal = (key: string) => /grand.?total|total.?cost|total.?invoice|total$/i.test(key);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {entries.map(([key, val]) => {
        const grand = isGrandTotal(key);
        return (
          <div
            key={key}
            className={`rounded-lg p-3 border ${grand ? "border-teal-400/40 bg-teal-400/10 col-span-2 sm:col-span-1" : "border-white/10 bg-white/5"}`}
          >
            <div className="text-xs text-gray-400 capitalize mb-1">
              {key.replace(/_/g, " ")}
            </div>
            <div className={`font-semibold ${grand ? "text-teal-300 text-lg" : "text-gray-200"}`}>
              {fmt(val)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Fields display ─────────────────────────────────────────────────────────────

function FieldsGrid({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!entries.length) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {entries.map(([key, val]) => (
        <div key={key} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
          <div className="text-xs text-gray-500 capitalize mb-0.5">{key.replace(/_/g, " ")}</div>
          <div className="text-sm text-gray-200 break-words">{fmt(val)}</div>
        </div>
      ))}
    </div>
  );
}

// ── Document card ─────────────────────────────────────────────────────────────

function DocumentCard({ doc, index }: { doc: FinancialDocument; index: number }) {
  const [open, setOpen] = useState(true);
  const label = DOC_TYPE_LABELS[doc.type] ?? "Document";
  const colorClass = DOC_TYPE_COLORS[doc.type] ?? DOC_TYPE_COLORS.other;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
        <span className="text-sm font-medium text-white">
          Document {index + 1}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${colorClass}`}>
          {label}
        </span>
        <span className="ml-auto text-xs text-gray-500">
          {doc.page_start === doc.page_end ? `p.${doc.page_start}` : `p.${doc.page_start}–${doc.page_end}`}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-white/10 pt-4">
          {/* Key fields */}
          {Object.keys(doc.fields).length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Header Fields</h4>
              <FieldsGrid fields={doc.fields} />
            </div>
          )}

          {/* Line items */}
          {doc.line_items.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Line Items ({doc.line_items.length})
              </h4>
              <LineItemsTable items={doc.line_items} docType={doc.type} />
            </div>
          )}

          {/* Totals */}
          {Object.keys(doc.totals).length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Totals</h4>
              <TotalsGrid totals={doc.totals} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Result panel ──────────────────────────────────────────────────────────────

function ResultPanel({ extraction }: { extraction: Extraction }) {
  const docs = extraction.documents ?? [];

  return (
    <div className="space-y-4">
      {/* Status header */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {extraction.status === "processing" ? (
          <span className="flex items-center gap-1.5 text-amber-400"><Loader2 className="w-4 h-4 animate-spin" /> Processing…</span>
        ) : extraction.status === "completed" ? (
          <span className="flex items-center gap-1.5 text-green-400"><CheckCircle2 className="w-4 h-4" /> Completed</span>
        ) : (
          <span className="flex items-center gap-1.5 text-red-400"><AlertCircle className="w-4 h-4" /> Failed</span>
        )}
        <span className="text-gray-500">{extraction.fileName}</span>
        {extraction.totalPages > 0 && <span className="text-gray-500">{extraction.totalPages}p</span>}
        {extraction.processingTimeMs > 0 && (
          <span className="flex items-center gap-1 text-gray-500"><Clock className="w-3 h-3" />{fmtTime(extraction.processingTimeMs)}</span>
        )}
        {extraction.detectedType && (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${DOC_TYPE_COLORS[extraction.detectedType] ?? DOC_TYPE_COLORS.other}`}>
            {DOC_TYPE_LABELS[extraction.detectedType] ?? extraction.detectedType}
          </span>
        )}
      </div>

      {extraction.errorMessage && (
        <div className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">
          {extraction.errorMessage}
        </div>
      )}

      {extraction.status === "processing" && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center text-gray-400">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-teal-400" />
          <p>Extracting financial data…</p>
          <p className="text-xs mt-1 text-gray-500">This takes 15–120 seconds depending on size</p>
        </div>
      )}

      {extraction.status === "completed" && docs.length === 0 && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center text-gray-400">
          No documents extracted.
        </div>
      )}

      {docs.map((doc, i) => (
        <DocumentCard key={i} doc={doc} index={i} />
      ))}
    </div>
  );
}

// ── History panel ─────────────────────────────────────────────────────────────

function HistoryItem({ ex, selected, onSelect }: { ex: Extraction; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-all ${
        selected ? "border-teal-400/60 bg-teal-400/10" : "border-white/10 bg-white/5 hover:bg-white/10"
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        <span className="text-sm text-gray-200 truncate">{ex.fileName}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-500 ml-5">
        {ex.status === "processing" ? (
          <span className="text-amber-400">Processing…</span>
        ) : ex.status === "failed" ? (
          <span className="text-red-400">Failed</span>
        ) : (
          <span className="text-green-400">Done</span>
        )}
        {ex.detectedType && <span>{DOC_TYPE_LABELS[ex.detectedType] ?? ex.detectedType}</span>}
        {ex.totalPages > 0 && <span>{ex.totalPages}p</span>}
      </div>
    </button>
  );
}

// ── Upload zone ───────────────────────────────────────────────────────────────

function UploadZone({ onUploaded }: { onUploaded: (id: number) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE}/api/financial-extractions/upload`, { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const data = await res.json();
      onUploaded(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [onUploaded]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    disabled: uploading,
  });

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all ${
          isDragActive
            ? "border-teal-400 bg-teal-400/10"
            : uploading
            ? "border-white/20 bg-white/5 opacity-60"
            : "border-white/20 bg-white/5 hover:border-teal-400/50 hover:bg-teal-400/5"
        }`}
      >
        <input {...getInputProps()} />
        {uploading ? (
          <>
            <Loader2 className="w-8 h-8 text-teal-400 animate-spin mx-auto mb-2" />
            <p className="text-sm text-gray-400">Uploading…</p>
          </>
        ) : (
          <>
            <Upload className="w-8 h-8 text-gray-500 mx-auto mb-2" />
            <p className="text-sm text-gray-300">
              {isDragActive ? "Drop the PDF here" : "Drop a PDF or click to browse"}
            </p>
            <p className="text-xs text-gray-500 mt-1">Change orders, invoices, receipts</p>
          </>
        )}
      </div>
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancialExtractPage() {
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const p = new URLSearchParams(window.location.search);
    const id = p.get("id");
    return id ? parseInt(id, 10) : null;
  });
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  const [detail, setDetail] = useState<Extraction | null>(null);
  const [polling, setPolling] = useState(false);

  // Fetch list
  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/financial-extractions`);
      if (!res.ok) return;
      const data = await res.json();
      setExtractions(data.extractions ?? []);
    } catch { /* ignore */ }
  }, []);

  // Fetch detail
  const fetchDetail = useCallback(async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/financial-extractions/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setDetail(data);
      return data as Extraction;
    } catch { /* ignore */ }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  // Auto-select first if none chosen
  useEffect(() => {
    if (!selectedId && extractions.length > 0) {
      setSelectedId(extractions[extractions.length - 1].id);
    }
  }, [extractions, selectedId]);

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedId) return;
    void fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  // Poll while processing
  useEffect(() => {
    if (!detail) return;
    if (detail.status !== "processing") { setPolling(false); return; }
    setPolling(true);
    const t = setInterval(async () => {
      const updated = await fetchDetail(detail.id);
      if (updated && updated.status !== "processing") {
        setPolling(false);
        clearInterval(t);
        void fetchList();
      }
    }, 3000);
    return () => clearInterval(t);
  }, [detail?.id, detail?.status, fetchDetail, fetchList]);

  function handleUploaded(id: number) {
    setSelectedId(id);
    void fetchList();
    void fetchDetail(id);
  }

  return (
    <div className="min-h-screen bg-[#0e1117] text-white">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Receipt className="w-7 h-7 text-teal-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Financial Documents</h1>
            <p className="text-sm text-gray-400">Extract data from change orders, supplier invoices, and receipts</p>
          </div>
          {polling && <Loader2 className="w-4 h-4 text-amber-400 animate-spin ml-auto" />}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          {/* Left: upload + history */}
          <div className="space-y-4">
            <UploadZone onUploaded={handleUploaded} />

            {extractions.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">History</h3>
                <div className="space-y-1.5 max-h-[50vh] overflow-y-auto pr-1">
                  {[...extractions].reverse().map((ex) => (
                    <HistoryItem
                      key={ex.id}
                      ex={ex}
                      selected={selectedId === ex.id}
                      onSelect={() => { setSelectedId(ex.id); }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: result */}
          <div>
            {detail ? (
              <ResultPanel extraction={detail} />
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/5 p-12 text-center text-gray-500">
                <Receipt className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p>Upload a financial document or select one from history</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
