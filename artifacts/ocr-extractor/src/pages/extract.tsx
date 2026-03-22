import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import { Upload, FileText, Image as ImageIcon, Loader2, AlertCircle } from "lucide-react";
import { useListSchemas } from "@workspace/api-client-react";
import { useUploadDocument } from "@/hooks/use-upload";
import { Card, CardContent } from "@/components/ui/card";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion } from "framer-motion";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function ExtractPage() {
  const [, setLocation] = useLocation();
  const { data: schemasData, isLoading: isLoadingSchemas } = useListSchemas();
  const schemas = schemasData?.schemas || [];
  
  const [selectedSchema, setSelectedSchema] = useState<number | null>(null);
  
  const uploadMutation = useUploadDocument();
  
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0 || !selectedSchema) return;
    
    uploadMutation.mutate(
      { schemaId: selectedSchema, file: acceptedFiles[0] },
      {
        onSuccess: (result) => {
          setLocation(`/extractions/${result.id}`);
        }
      }
    );
  }, [selectedSchema, uploadMutation, setLocation]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png': ['.png'],
      'application/pdf': ['.pdf']
    },
    maxFiles: 1,
    disabled: !selectedSchema || uploadMutation.isPending
  });

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-4xl mx-auto space-y-8"
    >
      <div>
        <h1 className="text-3xl font-display font-bold">Extract Data</h1>
        <p className="text-muted-foreground mt-2">
          Upload a document and extract structured information using a predefined schema.
        </p>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-medium">1. Select a Schema</h2>
        {isLoadingSchemas ? (
          <div className="h-32 flex items-center justify-center border border-border/50 rounded-xl bg-card/50">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : schemas.length === 0 ? (
          <Card className="border-dashed border-2">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="size-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No schemas found</h3>
              <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-sm">
                You need to create a schema before you can extract data. A schema defines what fields the AI should look for.
              </p>
              <button 
                onClick={() => setLocation("/schemas/new")}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
              >
                Create Schema
              </button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {schemas.map(schema => (
              <button
                key={schema.id}
                onClick={() => setSelectedSchema(schema.id)}
                className={cn(
                  "text-left p-4 rounded-xl border transition-all duration-200",
                  selectedSchema === schema.id
                    ? "bg-primary/10 border-primary ring-1 ring-primary shadow-[0_0_15px_rgba(20,184,166,0.15)]"
                    : "bg-card border-border hover:border-primary/50 hover:bg-muted/30"
                )}
              >
                <h3 className="font-semibold text-foreground">{schema.name}</h3>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{schema.description}</p>
                <div className="mt-3 flex items-center text-xs text-muted-foreground">
                  <span className="bg-muted px-2 py-1 rounded-md">{schema.fields.length} fields</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={cn("space-y-4 transition-opacity duration-300", !selectedSchema && "opacity-50 pointer-events-none")}>
        <h2 className="text-lg font-medium flex items-center gap-2">
          2. Upload Document
          {!selectedSchema && <span className="text-sm text-muted-foreground font-normal">(Select a schema first)</span>}
        </h2>
        
        <div 
          {...getRootProps()} 
          className={cn(
            "relative overflow-hidden group cursor-pointer border-2 border-dashed rounded-2xl p-12 text-center transition-all duration-300",
            isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/10",
            uploadMutation.isPending && "pointer-events-none opacity-80"
          )}
        >
          <input {...getInputProps()} />
          
          {uploadMutation.isPending ? (
            <div className="flex flex-col items-center justify-center space-y-4">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping" />
                <Loader2 className="size-12 text-primary animate-spin relative z-10" />
              </div>
              <div className="space-y-1">
                <p className="text-lg font-medium text-foreground">Processing Document...</p>
                <p className="text-sm text-muted-foreground">Extracting fields according to schema...</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center space-y-4">
              <div className="size-16 rounded-2xl bg-muted flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                <Upload className="size-8 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <div>
                <p className="text-lg font-medium text-foreground">
                  {isDragActive ? "Drop the file here" : "Drag & drop an image or PDF"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  or click to select from your computer
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground/80 mt-4">
                <span className="flex items-center gap-1"><ImageIcon className="size-3" /> JPG, PNG</span>
                <span className="flex items-center gap-1"><FileText className="size-3" /> PDF</span>
              </div>
            </div>
          )}
        </div>
        
        {uploadMutation.isError && (
          <div className="p-4 bg-destructive/10 text-destructive border border-destructive/20 rounded-xl flex items-start gap-3">
            <AlertCircle className="size-5 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold">Upload Failed</h4>
              <p className="text-sm mt-1">{uploadMutation.error?.message}</p>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
