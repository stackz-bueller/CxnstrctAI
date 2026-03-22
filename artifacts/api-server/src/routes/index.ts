import { Router, type IRouter } from "express";
import healthRouter from "./health";
import schemasRouter from "./ocr/schemas";
import extractionsRouter from "./ocr/extractions";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/schemas", schemasRouter);
router.use("/extractions", extractionsRouter);

export default router;
