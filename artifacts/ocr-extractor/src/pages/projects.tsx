import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  FolderOpen,
  Plus,
  Trash2,
  ChevronRight,
  Loader2,
  AlertCircle,
  HardHat,
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
    if (!confirm("Delete this project and all its chat history? Extracted documents will not be affected.")) return;
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
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
            <div className="size-10 rounded-xl bg-orange-500/10 flex items-center justify-center border border-orange-500/20">
              <HardHat className="size-5 text-orange-500" />
            </div>
            Project AI Agents
          </h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Each project is an isolated AI assistant trained on its own plans, specs, and documents.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium"
        >
          <Plus className="size-4" />
          New Project
        </button>
      </div>

      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="rounded-xl border border-border bg-card p-6 space-y-4 shadow-sm"
          >
            <h2 className="font-semibold text-foreground">Create New Project</h2>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-foreground block mb-1">Project Name *</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Wyoming Complex, Stone Arches Phase 2"
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") createProject(); if (e.key === "Escape") setShowCreate(false); }}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground block mb-1">Description (optional)</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Brief description of the project..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={createProject}
                disabled={!newName.trim() || creating}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                {creating && <Loader2 className="size-4 animate-spin" />}
                Create Project
              </button>
              <button
                onClick={() => { setShowCreate(false); setNewName(""); setNewDesc(""); }}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-3">
          <Loader2 className="size-5 animate-spin" />
          Loading projects...
        </div>
      ) : error ? (
        <div className="flex items-center gap-3 p-4 rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
          <AlertCircle className="size-5 shrink-0" />
          {error}
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-16 space-y-4">
          <div className="size-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
            <FolderOpen className="size-8 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-foreground">No projects yet</p>
            <p className="text-sm text-muted-foreground mt-1">Create a project and add extracted documents to start asking questions.</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium"
          >
            <Plus className="size-4" />
            Create First Project
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <motion.div
              key={project.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => navigate(`/projects/${project.id}`)}
              className="group flex items-center gap-4 p-4 rounded-xl border border-border bg-card hover:border-primary/30 hover:bg-primary/5 cursor-pointer transition-all"
            >
              <div className="size-10 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0">
                <HardHat className="size-5 text-orange-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-foreground truncate">{project.name}</p>
                {project.description && (
                  <p className="text-sm text-muted-foreground truncate mt-0.5">{project.description}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Created {new Date(project.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={(e) => deleteProject(project.id, e)}
                  disabled={deletingId === project.id}
                  className="size-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                >
                  {deletingId === project.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </button>
                <ChevronRight className="size-5 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
