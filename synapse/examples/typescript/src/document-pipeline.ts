// src/document-pipeline.ts — Event-driven document processing pipeline
import Synapse from "./synapse.js";
import * as fs from "fs";

async function main() {
  const mesh = await Synapse.connect("nats://localhost:4222");

  await mesh.register({
    name: "Document Pipeline",
    capabilities: ["documents"],
    skills: [],
  });

  // Subscribe to document uploads
  mesh.subscribe("document.>", (event) => {
    console.log(`[${event.event_type}]`, JSON.stringify(event.data));

    if (event.event_type === "uploaded") {
      const { filename, path } = event.data;
      console.log(`Processing: ${filename}`);

      fs.readFile(path, "utf-8", (err, content) => {
        if (err) {
          mesh.emit("document.error", { filename, error: err.message });
        } else {
          mesh.emit("document.processed", {
            filename,
            char_count: content.length,
            word_count: content.split(/\s+/).length,
          });
        }
      });
    }
  });

  console.log("Document pipeline online, watching for events...");

  process.on("SIGINT", async () => {
    await mesh.close();
    process.exit(0);
  });
}

main().catch(console.error);
