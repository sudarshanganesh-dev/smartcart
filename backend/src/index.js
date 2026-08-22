import "dotenv/config";
import express from "express";
import cors from "cors";
import { healthRouter } from "./routes/health.js";
import { merchantsRouter } from "./routes/merchants.js";
import { commerceRouter } from "./routes/commerce.js";
import { customerRouter } from "./routes/customer.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/merchants", merchantsRouter);
app.use("/api/commerce", commerceRouter);
app.use("/api/customer", customerRouter);

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
