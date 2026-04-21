// Server-side MOTIS client. Configures the fetch client with our MOTIS base URL.
// Keep all MOTIS calls behind Route Handlers so the URL stays out of the browser.
import { client } from "@motis-project/motis-client";

const MOTIS_URL = process.env.MOTIS_URL ?? "http://localhost:8080";

client.setConfig({ baseUrl: MOTIS_URL });

export * from "@motis-project/motis-client";
