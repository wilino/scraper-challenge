import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CorpusMembershipStore } from "../../src/core/corpus-membership-store.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true });
    }),
  );
});

const event = (
  partitionId: string,
  pass: number,
  uuid: string,
  identity = partitionId === "historical" ? { pdfUuid: uuid } : { documentUuid: uuid },
) => ({
  schemaVersion: 1 as const,
  type: "membership" as const,
  partitionId,
  pass,
  membershipToken: uuid,
  identity,
  observedAt: "2026-07-16T00:00:00.000Z",
});

describe("CorpusMembershipStore", () => {
  it("es idempotente por pasada y calcula regiones entre particiones", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pj-memberships-"));
    temporary.push(directory);
    const store = new CorpusMembershipStore(path.join(directory, "memberships.jsonl"));
    const shared = "00000000-0000-4000-8000-000000000201";
    const exclusive = "00000000-0000-4000-8000-000000000202";

    await expect(store.record(event("superior", 1, shared))).resolves.toEqual({
      insertedInPass: true,
      newForPartition: true,
    });
    await expect(store.record(event("superior", 1, shared))).resolves.toEqual({
      insertedInPass: false,
      newForPartition: false,
    });
    await expect(store.record(event("superior", 2, shared))).resolves.toEqual({
      insertedInPass: true,
      newForPartition: false,
    });
    await store.record(event("historical", 1, shared));
    await store.record(event("historical", 1, exclusive));

    expect(store.regions()).toEqual([
      { partitions: ["historical"], documents: 1 },
      { partitions: ["historical", "superior"], documents: 1 },
    ]);
  });

  it("une documentUuid y pdfUuid aunque los membershipToken sean distintos", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pj-membership-aliases-"));
    temporary.push(directory);
    const store = new CorpusMembershipStore(path.join(directory, "memberships.jsonl"));
    const documentUuid = "00000000-0000-4000-8000-000000000301";
    const pdfUuid = "00000000-0000-4000-8000-000000009301";

    await store.record(event("superior", 1, documentUuid, { documentUuid, pdfUuid }));
    await store.record(event("historical", 1, pdfUuid, { pdfUuid }));

    expect(store.regions()).toEqual([{ partitions: ["historical", "superior"], documents: 1 }]);
  });

  it("rehidrata un ledger sintético grande sin arrays de eventos y conserva idempotencia", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pj-membership-scale-"));
    temporary.push(directory);
    const filePath = path.join(directory, "memberships.jsonl");
    const total = 10_000;
    const events = Array.from({ length: total }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return JSON.stringify(event("supreme", 1, id));
    });
    await writeFile(filePath, `${events.join("\n")}\n`, "utf8");

    const store = new CorpusMembershipStore(filePath);
    await store.initialize();
    expect(store.newInPass("supreme", 1)).toBe(total);
    await expect(store.record(event("supreme", 1, eventId(total - 1)))).resolves.toEqual({
      insertedInPass: false,
      newForPartition: false,
    });
    await expect(store.record(event("supreme", 2, eventId(total - 1)))).resolves.toEqual({
      insertedInPass: true,
      newForPartition: false,
    });
    expect(store.newInPass("supreme", 2)).toBe(1);
  });
});

function eventId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
