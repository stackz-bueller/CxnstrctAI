import { Badge } from "@/components/ui/badge";

export function ConfidenceBadge({ score }: { score: number }) {
  if (score >= 0.8) {
    return <Badge variant="success">{(score * 100).toFixed(0)}% Confident</Badge>;
  }
  if (score >= 0.5) {
    return <Badge variant="warning">{(score * 100).toFixed(0)}% Confident</Badge>;
  }
  return <Badge variant="destructive">{(score * 100).toFixed(0)}% Confident</Badge>;
}
