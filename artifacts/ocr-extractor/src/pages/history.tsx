import { useLocation } from "wouter";
import { format } from "date-fns";
import { FileText, ChevronRight, History as HistoryIcon, Search } from "lucide-react";
import { useListExtractions } from "@workspace/api-client-react";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { Card } from "@/components/ui/card";
import { motion } from "framer-motion";

export default function HistoryPage() {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useListExtractions();
  const extractions = data?.extractions || [];

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-6xl mx-auto space-y-6"
    >
      <div>
        <h1 className="text-3xl font-display font-bold flex items-center gap-3">
          <HistoryIcon className="size-8 text-primary" />
          Extraction History
        </h1>
        <p className="text-muted-foreground mt-2">
          Review all past documents processed through your schemas.
        </p>
      </div>

      <Card className="border-border overflow-hidden">
        <div className="p-4 bg-muted/20 border-b border-border flex items-center justify-between">
          <div className="relative max-w-sm w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input 
              placeholder="Search by file name..." 
              className="w-full bg-background border border-border rounded-lg pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="divide-y divide-border">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="p-4 flex items-center gap-4 animate-pulse">
                <div className="size-10 bg-muted rounded-lg shrink-0" />
                <div className="space-y-2 flex-1">
                  <div className="h-4 bg-muted rounded w-1/4" />
                  <div className="h-3 bg-muted rounded w-1/3" />
                </div>
                <div className="h-6 bg-muted rounded w-20" />
              </div>
            ))}
          </div>
        ) : extractions.length === 0 ? (
          <div className="p-16 text-center text-muted-foreground flex flex-col items-center">
            <FileText className="size-12 mb-4 opacity-20" />
            <p>No extractions found.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/40 text-muted-foreground font-medium uppercase tracking-wider text-xs">
                <tr>
                  <th className="px-6 py-4">Document</th>
                  <th className="px-6 py-4">Schema</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Confidence</th>
                  <th className="px-6 py-4">Date</th>
                  <th className="px-6 py-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {extractions.map(ext => (
                  <tr 
                    key={ext.id}
                    onClick={() => setLocation(`/extractions/${ext.id}`)}
                    className="hover:bg-muted/30 cursor-pointer transition-colors group"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="size-8 rounded bg-primary/10 flex items-center justify-center shrink-0">
                          <FileText className="size-4 text-primary" />
                        </div>
                        <span className="font-medium text-foreground truncate max-w-[200px]">
                          {ext.fileName}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs">
                      {ext.schemaName}
                    </td>
                    <td className="px-6 py-4">
                      <span className="capitalize text-xs font-semibold px-2 py-1 rounded-md bg-secondary text-secondary-foreground border border-border">
                        {ext.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {ext.status === 'completed' && <ConfidenceBadge score={ext.overallConfidence} />}
                    </td>
                    <td className="px-6 py-4 text-muted-foreground">
                      {format(new Date(ext.createdAt), 'MMM d, yyyy HH:mm')}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground inline-block transition-colors" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </motion.div>
  );
}
