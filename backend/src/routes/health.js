import { Router } from "express";
import { checkDatabaseConnection } from "../db/healthCheck.js";

export const healthRouter = Router();

healthRouter.get("/", async (req, res) => {
  const database = await checkDatabaseConnection();

  res.json({
    status: "ok",
    database,
  });
});
