import { Router, type IRouter } from "express";
import healthRouter from "./health";
import schemasRouter from "./ocr/schemas";
import extractionsRouter from "./ocr/extractions";
import pdfExtractionsRouter from "./ocr/pdf-extractions";
import specExtractionsRouter from "./ocr/spec-extractions";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/schemas", schemasRouter);
router.use("/extractions", extractionsRouter);
router.use("/pdf-extractions", pdfExtractionsRouter);
router.use("/spec-extractions", specExtractionsRouter);

export default router;
