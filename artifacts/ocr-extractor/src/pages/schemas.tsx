import { useLocation } from "wouter";
import { format } from "date-fns";
import { Plus, Trash2, Database, AlertCircle, FileCode2 } from "lucide-react";
import { useListSchemas, useDeleteSchema } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";

export default function SchemasPage() {
  const [, setLocation] = useLocation();
  const { data, isLoading, refetch } = useListSchemas();
  const deleteMutation = useDeleteSchema();
  
  const schemas = data?.schemas || [];

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this schema? All past extractions relying on it might lose reference data.")) return;
    
    await deleteMutation.mutateAsync({ id });
    refetch();
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-6xl mx-auto space-y-8"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold flex items-center gap-3">
            <Database className="size-8 text-primary" />
            Document Schemas
          </h1>
          <p className="text-muted-foreground mt-2">
            Define extraction templates to ensure AI returns consistent, structured data.
          </p>
        </div>
        
        <button
          onClick={() => setLocation("/schemas/new")}
          className="flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98]"
        >
          <Plus className="size-5" />
          Create Schema
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <Card key={i} className="h-48 animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : schemas.length === 0 ? (
        <Card className="border-dashed border-2 bg-transparent">
          <CardContent className="flex flex-col items-center justify-center py-20 text-center">
            <div className="size-20 bg-muted rounded-full flex items-center justify-center mb-6">
              <FileCode2 className="size-10 text-muted-foreground" />
            </div>
            <h3 className="text-2xl font-display font-semibold mb-2">No schemas defined</h3>
            <p className="text-muted-foreground max-w-md mx-auto mb-8">
              Create your first document schema to start extracting structured information from your files. A schema locks the AI into finding exact fields.
            </p>
            <button
              onClick={() => setLocation("/schemas/new")}
              className="flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-all"
            >
              <Plus className="size-5" />
              Create First Schema
            </button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {schemas.map((schema) => (
            <Card 
              key={schema.id} 
              className="group overflow-hidden border-border/50 hover:border-primary/50 hover:shadow-xl hover:shadow-primary/5 transition-all duration-300 flex flex-col cursor-pointer"
              onClick={() => setLocation(`/schemas/${schema.id}`)}
            >
              <div className="p-6 flex-1">
                <div className="flex justify-between items-start mb-4">
                  <h3 className="text-xl font-semibold text-foreground group-hover:text-primary transition-colors">
                    {schema.name}
                  </h3>
                  <button 
                    onClick={(e) => handleDelete(schema.id, e)}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-3 mb-6">
                  {schema.description}
                </p>
                
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Fields Preview</h4>
                  <div className="flex flex-wrap gap-2">
                    {schema.fields.slice(0, 3).map(f => (
                      <span key={f.name} className="px-2 py-1 text-xs font-mono bg-muted rounded-md border border-border">
                        {f.name}
                      </span>
                    ))}
                    {schema.fields.length > 3 && (
                      <span className="px-2 py-1 text-xs font-mono bg-muted/50 text-muted-foreground rounded-md">
                        +{schema.fields.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="px-6 py-3 bg-muted/30 border-t border-border/50 text-xs text-muted-foreground">
                Created {format(new Date(schema.createdAt), 'MMM d, yyyy')}
              </div>
            </Card>
          ))}
        </div>
      )}
    </motion.div>
  );
}
