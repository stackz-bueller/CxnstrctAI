import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  HardHat,
  MessageSquare,
  ArrowRight,
  FileText,
} from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Project = {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export default function ProjectsPage() {
  const [, navigate] = useLocation();
  const [location] = useLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function fetchProjects() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects`);
      if (!res.ok) throw new Error("Failed to load projects");
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchProjects(); }, []);

  useEffect(() => {
    if (location.includes("new=1")) {
      setShowCreate(true);
    }
  }, [location]);

  async function createProject() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined }),
      });
      if (!res.ok) throw new Error("Failed to create project");
      const project = await res.json();
      setProjects((prev) => [project, ...prev]);
      setNewName("");
      setNewDesc("");
      setShowCreate(false);
      navigate(`/projects/${project.id}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this project and all its chat history?")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch {
      alert("Failed to delete project");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="h-full flex flex-col">
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground gap-3">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-sm">Loading projects...</span>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-3 p-4 rounded-xl border border-destructive/30 bg-destructive/10 text-destructive max-w-md">
            <AlertCircle className="size-5 shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        </div>
      ) : projects.length === 0 && !showCreate ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-lg text-center space-y-6 px-4">
            <div className="size-20 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto border border-primary/20">
              <HardHat className="size-10 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Welcome to ConstructAI</h1>
              <p className="text-muted-foreground mt-3 leading-relaxed">
                Your AI assistant for construction documents. Create a project, attach your plans and specs, and start asking questions.
              </p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium"
            >
              <Plus className="size-4" />
              Create your first project
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-semibold text-foreground">Your Projects</h1>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-xs font-medium"
              >
                <Plus className="size-3.5" />
                New
              </button>
            </div>

            <AnimatePresence>
              {showCreate && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1.5">PROJECT NAME</label>
                        <input
                          type="text"
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          placeholder="e.g. Wyoming Complex, Stone Arches Phase 2"
                          className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50"
                          autoFocus
                          onKeyDown={(e) => { if (e.key === "Enter") createProject(); if (e.key === "Escape") { setShowCreate(false); setNewName(""); setNewDesc(""); } }}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1.5">DESCRIPTION (OPTIONAL)</label>
                        <input
                          type="text"
                          value={newDesc}
                          onChange={(e) => setNewDesc(e.target.value)}
                          placeholder="Brief description..."
                          className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={createProject}
                        disabled={!newName.trim() || creating}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors text-sm font-medium"
                      >
                        {creating ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
                        Create
                      </button>
                      <button
                        onClick={() => { setShowCreate(false); setNewName(""); setNewDesc(""); }}
                        className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-1">
              {projects.map((project) => (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  onClick={() => navigate(`/projects/${project.id}`)}
                  className="group flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors -mx-3"
                >
                  <div className="size-9 rounded-lg bg-card border border-border flex items-center justify-center shrink-0">
                    <MessageSquare className="size-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{project.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {project.description ? project.description : `Created ${new Date(project.createdAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <button
                    onClick={(e) => deleteProject(project.id, e)}
                    disabled={deletingId === project.id}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    {deletingId === project.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </button>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
