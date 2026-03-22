import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExtractionResult } from "@workspace/api-client-react";
import { getListExtractionsQueryKey } from "@workspace/api-client-react";

export function useUploadDocument() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ schemaId, file }: { schemaId: number; file: File }) => {
      const formData = new FormData();
      formData.append("schemaId", schemaId.toString());
      formData.append("file", file);
      
      const res = await fetch("/api/extractions/upload", {
        method: "POST",
        body: formData,
      });
      
      if (!res.ok) {
        let errorMsg = "Upload failed";
        try {
          const err = await res.json();
          errorMsg = err.error || errorMsg;
        } catch (e) {
          // ignore
        }
        throw new Error(errorMsg);
      }
      
      return res.json() as Promise<ExtractionResult>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListExtractionsQueryKey() });
    },
  });
}
