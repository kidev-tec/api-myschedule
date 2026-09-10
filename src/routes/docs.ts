import { Hono } from "hono";
import { openApiSpec } from "../openapi.js";
import type { AppEnv } from "../types.js";

/** Doc HTML da API — Scalar UI via CDN (zero dependência npm). */
function scalarHtml(): string {
	return `<!doctype html>
<html lang="pt-BR">
  <head>
    <title>Minha Agenda API — Docs</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" type="application/json">
${JSON.stringify(openApiSpec)}
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}

export function docsRoutes() {
	const routes = new Hono<AppEnv>();

	// Spec crua (pra Postman/Insomnia/import externo)
	routes.get("/openapi.json", (c) => c.json(openApiSpec));

	// UI human-readable
	routes.get("/docs", (c) => c.html(scalarHtml()));

	return routes;
}
