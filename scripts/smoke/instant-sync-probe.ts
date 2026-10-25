import { InstantTools } from "@/domains/integrations/instant-tools";

async function main() {
  const r = await InstantTools.syncInstantCatalog({ apiKey: process.env.COMPOSIO_API_KEY ?? "" });
  console.log("sync result:", JSON.stringify(r));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
