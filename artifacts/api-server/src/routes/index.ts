import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import schemasRouter from "./ocr/schemas";
import extractionsRouter from "./ocr/extractions";
import pdfExtractionsRouter from "./ocr/pdf-extractions";
import specExtractionsRouter from "./ocr/spec-extractions";
import financialExtractionsRouter from "./ocr/financial-extractions";
import smartUploadRouter from "./ocr/smart-upload";
import projectsRouter from "./projects/router";
import costsRouter from "./costs";
import adminRouter from "./admin";
import { requireAuth } from "../lib/require-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);

router.use("/schemas", requireAuth, schemasRouter);
router.use("/extractions", requireAuth, extractionsRouter);
router.use("/pdf-extractions", requireAuth, pdfExtractionsRouter);
router.use("/spec-extractions", requireAuth, specExtractionsRouter);
router.use("/financial-extractions", requireAuth, financialExtractionsRouter);
router.use("/smart-upload", requireAuth, smartUploadRouter);
router.use("/projects", requireAuth, projectsRouter);
router.use("/costs", requireAuth, costsRouter);
router.use("/admin", requireAuth, adminRouter);

export default router;
