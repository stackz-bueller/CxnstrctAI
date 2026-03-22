import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { documentSchemasTable, schemaFieldSchema } from "@workspace/db/schema";
import { CreateSchemaBody, GetSchemaParams, DeleteSchemaParams } from "@workspace/api-zod";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/", async (req, res) => {
  try {
    const schemas = await db.select().from(documentSchemasTable).orderBy(documentSchemasTable.createdAt);
    res.json({ schemas: schemas.map(s => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }))});
  } catch (err) {
    req.log.error({ err }, "Failed to list schemas");
    res.status(500).json({ error: "Failed to list schemas" });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = CreateSchemaBody.parse(req.body);
    const fieldsArr = Array.isArray(body.fields) ? body.fields : [];
    const validatedFields = fieldsArr.map((f) => schemaFieldSchema.parse(f));
    const [schema] = await db
      .insert(documentSchemasTable)
      .values({
        name: body.name,
        description: body.description,
        fields: validatedFields,
      })
      .returning();
    res.status(201).json({
      ...schema,
      createdAt: schema.createdAt.toISOString(),
      updatedAt: schema.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create schema");
    res.status(500).json({ error: "Failed to create schema" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = GetSchemaParams.parse({ id: parseInt(req.params.id) });
    const [schema] = await db.select().from(documentSchemasTable).where(eq(documentSchemasTable.id, id));
    if (!schema) {
      res.status(404).json({ error: "Schema not found" });
      return;
    }
    res.json({
      ...schema,
      createdAt: schema.createdAt.toISOString(),
      updatedAt: schema.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get schema");
    res.status(500).json({ error: "Failed to get schema" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = DeleteSchemaParams.parse({ id: parseInt(req.params.id) });
    await db.delete(documentSchemasTable).where(eq(documentSchemasTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete schema");
    res.status(500).json({ error: "Failed to delete schema" });
  }
});

export default router;
