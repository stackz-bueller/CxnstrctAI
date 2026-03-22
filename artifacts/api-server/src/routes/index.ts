import { Router, type IRouter } from "express";
import healthRouter from "./health";
import schemasRouter from "./ocr/schemas";
import extractionsRouter from "./ocr/extractions";
import pdfExtractionsRouter from "./ocr/pdf-extractions";
import specExtractionsRouter from "./ocr/spec-extractions";
import financialExtractionsRouter from "./ocr/financial-extractions";
import smartUploadRouter from "./ocr/smart-upload";
import projectsRouter from "./projects/router";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/schemas", schemasRouter);
router.use("/extractions", extractionsRouter);
router.use("/pdf-extractions", pdfExtractionsRouter);
router.use("/spec-extractions", specExtractionsRouter);
router.use("/financial-extractions", financialExtractionsRouter);
router.use("/smart-upload", smartUploadRouter);
router.use("/projects", projectsRouter);

export default router;
