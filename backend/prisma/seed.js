import { prisma } from "../src/lib/prisma.js";

async function main() {
  const merchant = await prisma.merchant.upsert({
    where: { slug: "demo-merchant" },
    update: {},
    create: {
      name: "Demo Merchant",
      slug: "demo-merchant",
    },
  });

  console.log(`Seeded demo merchant: ${merchant.id} (${merchant.slug})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
