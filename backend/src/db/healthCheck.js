import { prisma } from "../lib/prisma.js";

export async function checkDatabaseConnection() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { connected: true };
  } catch {
    // A fixed string, never the raw driver error — that error can vary by
    // failure mode and there's no need to expose any of it to a client.
    return { connected: false, error: "DATABASE_UNREACHABLE" };
  }
}
