import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Fachadas sin lógica propia; su comportamiento se cubre a través de los módulos exportados.
      exclude: ["src/cli.ts", "src/models/index.ts", "src/sites/pj/index.ts", "src/utils/index.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
        "src/core/checkpoint-store.ts": { lines: 90, branches: 85 },
        "src/core/retry-policy.ts": { lines: 90, branches: 85 },
        // Excepciones baseline. Responsable: wilino. Retiro: 2026-08-15.
        // El objetivo sigue en 90% líneas / 85% ramas; estos floors evitan regresiones mientras
        // se completan contratos de ramas legacy sin ocultarlas del reporte global.
        "src/core/discovery-orchestrator.ts": { lines: 88, branches: 74 },
        "src/core/http-client.ts": { lines: 90, branches: 81 },
        "src/core/rate-limiter.ts": { lines: 89, branches: 75 },
        "src/sites/pj/parser.ts": { lines: 90, branches: 78 },
        "src/sites/pj/request-builders.ts": { lines: 90, branches: 76 },
      },
    },
  },
});
