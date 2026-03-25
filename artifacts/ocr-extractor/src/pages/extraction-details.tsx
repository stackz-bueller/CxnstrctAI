import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { format } from "date-fns";
import { 
  ArrowLeft, FileText, CheckCircle2, AlertCircle, 
  Clock, Code, Table2, Info, Loader2, Maximize2
} from "lucide-react";
import { useGetExtraction, useGetExtractionRawText } from "@workspace/api-client-react";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion } from "framer-motion";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function ExtractionDetailsPage() {
  const [, params] = useRoute("/extractions/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  const [, setLocation] = useLocation();
  
  const [activeTab, setActiveTab] = useState<"structured" | "raw">("structured");
  
  const { data: extraction, isLoading, isError } = useGetExtraction(id);
  const { data: rawTextData } = useGetExtractionRawText(id, { query: { enabled: activeTab === "raw" } as any });

  if (isLoading) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-muted-foreground">
          <Loader2 className="size-10 animate-spin text-primary" />
          <p>Loading extraction results...</p>
        </div>
      </div>
    );
  }

  if (isError || !extraction) {
    return (
      <div className="p-8 text-center text-destructive">
        <AlertCircle className="size-10 mx-auto mb-4" />
        <h2 className="text-xl font-semibold">Error Loading Results</h2>
        <p>Could not find this extraction record.</p>
        <button onClick={() => setLocation("/history")} className="mt-4 text-primary underline">Back to History</button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => window.history.back()}
            className="p-2 bg-muted hover:bg-muted/80 rounded-full transition-colors"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div>
            <h1 className="text-2xl font-display font-bold flex items-center gap-3">
              {extraction.fileName}
            </h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1 font-mono text-xs px-2 py-0.5 bg-muted rounded-md border border-border">
                Schema: {extraction.schemaName}
              </span>
              <span>•</span>
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {format(new Date(extraction.createdAt), 'MMM d, yyyy HH:mm')}
              </span>
              <span>•</span>
              <span>{extraction.processingTimeMs}ms processing</span>
            </div>
          </div>
        </div>
        
        {extraction.status === 'completed' && (
          <div className="flex items-center gap-4 bg-card px-4 py-2 rounded-xl border shadow-sm">
            <div className="text-sm font-medium text-muted-foreground">Overall Confidence:</div>
            <ConfidenceBadge score={extraction.overallConfidence} />
          </div>
        )}
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0">
        {/* Left Pane: Document Viewer */}
        <Card className="flex flex-col overflow-hidden border-border/50">
          <CardHeader className="py-3 px-4 border-b border-border bg-muted/10 flex flex-row items-center justify-between shrink-0">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileText className="size-4 text-primary" />
              Source Document
            </CardTitle>
            <button className="text-muted-foreground hover:text-foreground">
              <Maximize2 className="size-4" />
            </button>
          </CardHeader>
          <CardContent className="p-0 flex-1 relative bg-black/20 flex items-center justify-center overflow-auto">
            {/* Fallback mock view if we don't have a real file URL */}
            <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground/50 select-none p-8">
              <FileText className="size-32 mb-6 opacity-20" />
              <p className="text-lg font-display">Document Viewer</p>
              <p className="text-sm text-center max-w-sm mt-2">
                In a production environment, the uploaded {extraction.fileType} file would be rendered here for side-by-side verification.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Right Pane: Extraction Results */}
        <Card className="flex flex-col overflow-hidden border-border/50">
          <div className="flex items-center border-b border-border bg-muted/10 shrink-0">
            <button 
              onClick={() => setActiveTab("structured")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === "structured" ? "border-primary text-foreground bg-primary/5" : "border-transparent text-muted-foreground hover:bg-muted/50"
              )}
            >
              <Table2 className="size-4" /> Structured Data
            </button>
            <button 
              onClick={() => setActiveTab("raw")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === "raw" ? "border-primary text-foreground bg-primary/5" : "border-transparent text-muted-foreground hover:bg-muted/50"
              )}
            >
              <Code className="size-4" /> Raw OCR Text
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-0">
            {activeTab === "structured" ? (
              <div className="divide-y divide-border/40">
                {extraction.fields.map(field => (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    key={field.name} 
                    className="p-4 hover:bg-muted/10 transition-colors flex flex-col sm:flex-row sm:items-start gap-4"
                  >
                    <div className="w-full sm:w-1/3 shrink-0">
                      <div className="font-medium text-sm text-foreground flex items-center gap-2">
                        {field.label}
                        {!field.present && <Info className="size-3 text-destructive" />}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{field.name}</div>
                    </div>
                    
                    <div className="flex-1">
                      {field.present ? (
                        <div className="bg-muted/30 border border-border/50 rounded-lg p-3 text-sm font-mono whitespace-pre-wrap break-all shadow-inner">
                          {typeof field.value === 'object' ? JSON.stringify(field.value, null, 2) : String(field.value)}
                        </div>
                      ) : (
                        <div className="text-sm italic text-muted-foreground bg-destructive/5 text-destructive/80 border border-destructive/10 rounded-lg p-3">
                          Value not found in document
                        </div>
                      )}
                    </div>
                    
                    <div className="shrink-0 w-24 flex justify-end">
                      {field.present ? (
                        <ConfidenceBadge score={field.confidence} />
                      ) : (
                        <span className="text-xs text-muted-foreground font-medium bg-muted px-2 py-1 rounded">N/A</span>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="p-4 h-full">
                {rawTextData ? (
                  <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap bg-black/40 p-4 rounded-lg border border-border h-full overflow-auto shadow-inner">
                    {rawTextData.rawText}
                  </pre>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <Loader2 className="size-6 animate-spin mr-2" /> Loading raw text...
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
