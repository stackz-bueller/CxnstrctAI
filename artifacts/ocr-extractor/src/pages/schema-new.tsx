import { useLocation } from "wouter";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ArrowLeft, Plus, Trash2, Save, Loader2, AlertCircle } from "lucide-react";
import { useCreateSchema } from "@workspace/api-client-react";
import { SchemaFieldType } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";

const fieldSchema = z.object({
  name: z.string().min(1, "Required").regex(/^[a-z0-9_]+$/, "Must be snake_case (e.g., total_amount)"),
  label: z.string().min(1, "Required"),
  type: z.nativeEnum(SchemaFieldType),
  description: z.string().min(1, "Required"),
  required: z.boolean().default(false),
  example: z.string().optional(),
});

const formSchema = z.object({
  name: z.string().min(1, "Schema name is required"),
  description: z.string().min(1, "Description is required"),
  fields: z.array(fieldSchema).min(1, "At least one field is required"),
});

type FormValues = z.infer<typeof formSchema>;

export default function SchemaNewPage() {
  const [, setLocation] = useLocation();
  const createMutation = useCreateSchema();
  
  const { register, control, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      description: "",
      fields: [
        { name: "", label: "", type: "string", description: "", required: true, example: "" }
      ]
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "fields"
  });

  const onSubmit = async (data: FormValues) => {
    try {
      await createMutation.mutateAsync({ data });
      setLocation("/schemas");
    } catch (e) {
      // error handled by UI
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      className="max-w-4xl mx-auto space-y-6 pb-20"
    >
      <div className="flex items-center gap-4">
        <button 
          onClick={() => window.history.back()}
          className="p-2 bg-muted hover:bg-muted/80 rounded-full transition-colors"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div>
          <h1 className="text-3xl font-display font-bold">Create Schema</h1>
          <p className="text-muted-foreground mt-1">Design the extraction structure for your documents.</p>
        </div>
      </div>

      {createMutation.isError && (
        <div className="p-4 bg-destructive/10 text-destructive border border-destructive/20 rounded-xl flex items-center gap-3">
          <AlertCircle className="size-5" />
          <p>{createMutation.error?.message || "Failed to create schema"}</p>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Schema Name</label>
              <input 
                {...register("name")} 
                className="w-full bg-background border border-border rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="e.g. Acme Inc Invoice"
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <textarea 
                {...register("description")} 
                className="w-full bg-background border border-border rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/50 h-24 resize-none"
                placeholder="What kind of documents is this for?"
              />
              {errors.description && <p className="text-xs text-destructive">{errors.description.message}</p>}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Schema Fields</h2>
            <button
              type="button"
              onClick={() => append({ name: "", label: "", type: "string", description: "", required: false, example: "" })}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors"
            >
              <Plus className="size-4" /> Add Field
            </button>
          </div>

          {errors.fields?.root && (
            <p className="text-sm text-destructive">{errors.fields.root.message}</p>
          )}

          <div className="space-y-4">
            {fields.map((field, index) => (
              <Card key={field.id} className="border border-border/60 shadow-none overflow-hidden group">
                <div className="bg-muted/30 px-4 py-3 border-b border-border/60 flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground font-mono">Field #{index + 1}</span>
                  {fields.length > 1 && (
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
                <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Field Key (snake_case)</label>
                    <input 
                      {...register(`fields.${index}.name`)} 
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                      placeholder="e.g. invoice_total"
                    />
                    {errors.fields?.[index]?.name && <p className="text-xs text-destructive">{errors.fields[index].name?.message}</p>}
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Display Label</label>
                    <input 
                      {...register(`fields.${index}.label`)} 
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      placeholder="e.g. Total Amount"
                    />
                    {errors.fields?.[index]?.label && <p className="text-xs text-destructive">{errors.fields[index].label?.message}</p>}
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Data Type</label>
                    <select 
                      {...register(`fields.${index}.type`)} 
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="string">String (Text)</option>
                      <option value="number">Number</option>
                      <option value="date">Date</option>
                      <option value="boolean">Boolean (Yes/No)</option>
                      <option value="array">Array (List)</option>
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Example Value (Optional)</label>
                    <input 
                      {...register(`fields.${index}.example`)} 
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      placeholder="e.g. $1,250.00"
                    />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <label className="text-xs font-medium text-muted-foreground">Extraction Instructions</label>
                    <input 
                      {...register(`fields.${index}.description`)} 
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      placeholder="Explain to the AI exactly what this field means and where to find it..."
                    />
                    {errors.fields?.[index]?.description && <p className="text-xs text-destructive">{errors.fields[index].description?.message}</p>}
                  </div>

                  <div className="md:col-span-2 flex items-center gap-2 mt-2">
                    <input 
                      type="checkbox" 
                      id={`required-${index}`}
                      {...register(`fields.${index}.required`)} 
                      className="rounded border-border bg-background text-primary focus:ring-primary/50 size-4"
                    />
                    <label htmlFor={`required-${index}`} className="text-sm">This field is strictly required to be found</label>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <div className="fixed bottom-0 left-0 right-0 md:left-64 p-4 bg-background/80 backdrop-blur-xl border-t border-border z-10">
          <div className="max-w-4xl mx-auto flex justify-end">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="flex items-center gap-2 px-8 py-3 bg-primary text-primary-foreground font-semibold rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-50 disabled:pointer-events-none"
            >
              {createMutation.isPending ? <Loader2 className="size-5 animate-spin" /> : <Save className="size-5" />}
              Save Schema
            </button>
          </div>
        </div>
      </form>
    </motion.div>
  );
}
