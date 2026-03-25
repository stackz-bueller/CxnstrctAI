import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

function requireSuperuser(req: Request, res: Response, next: () => void) {
  if (req.user?.role !== "superuser") {
    res.status(403).json({ error: "Superuser access required" });
    return;
  }
  next();
}

router.get("/users", requireSuperuser, async (req: Request, res: Response) => {
  try {
    const users = await db
      .select()
      .from(usersTable)
      .orderBy(desc(usersTable.createdAt));
    res.json({ users });
  } catch (err) {
    req.log.error({ err }, "Failed to list users");
    res.status(500).json({ error: "Failed to list users" });
  }
});

router.patch("/users/:userId/role", requireSuperuser, async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const bodySchema = z.object({
    role: z.enum(["user", "superuser"]),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }

  try {
    const [updated] = await db
      .update(usersTable)
      .set({ role: parsed.data.role, updatedAt: new Date() })
      .where(eq(usersTable.id, userId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to update user role");
    res.status(500).json({ error: "Failed to update user role" });
  }
});

export default router;
