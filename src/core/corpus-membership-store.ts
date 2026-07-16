import type { CorpusMembership } from "../models/corpus-membership.js";
import { corpusMembershipSchema } from "../models/corpus-membership.js";
import { JsonlStore } from "./jsonl-store.js";

function passKey(partitionId: string, pass: number, token: string): string {
  return `${partitionId}\u0000${String(pass)}\u0000${token}`;
}

function partitionKey(partitionId: string, token: string): string {
  return `${partitionId}\u0000${token}`;
}

class DisjointSet {
  readonly #parent = new Map<string, string>();

  constructor(keys: readonly string[]) {
    for (const key of keys) this.#parent.set(key, key);
  }

  find(key: string): string {
    const parent = this.#parent.get(key);
    if (parent === undefined) throw new Error("Nodo de membresía inexistente");
    if (parent === key) return key;
    const root = this.find(parent);
    this.#parent.set(key, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.#parent.set(rightRoot, leftRoot);
  }
}

export interface MembershipInsertResult {
  insertedInPass: boolean;
  newForPartition: boolean;
}

export interface MembershipRegion {
  partitions: string[];
  documents: number;
}

export class CorpusMembershipStore {
  readonly #store: JsonlStore<CorpusMembership>;
  readonly #passKeys = new Set<string>();
  readonly #partitionKeys = new Set<string>();
  readonly #identityByMembership = new Map<string, CorpusMembership["identity"]>();
  #loaded = false;

  constructor(filePath: string) {
    this.#store = new JsonlStore(filePath, corpusMembershipSchema);
  }

  async initialize(): Promise<void> {
    if (this.#loaded) return;
    const { records } = await this.#store.readAll();
    for (const membership of records) this.#remember(membership);
    this.#loaded = true;
  }

  async record(input: CorpusMembership): Promise<MembershipInsertResult> {
    await this.initialize();
    const membership = corpusMembershipSchema.parse(input);
    const perPass = passKey(membership.partitionId, membership.pass, membership.membershipToken);
    const perPartition = partitionKey(membership.partitionId, membership.membershipToken);
    if (this.#passKeys.has(perPass)) {
      return { insertedInPass: false, newForPartition: false };
    }
    const newForPartition = !this.#partitionKeys.has(perPartition);
    await this.#store.append(membership);
    this.#remember(membership);
    return { insertedInPass: true, newForPartition };
  }

  regions(): MembershipRegion[] {
    const keys = [...this.#identityByMembership.keys()];
    const dsu = new DisjointSet(keys);
    const aliases = new Map<string, string>();
    for (const [key, identity] of this.#identityByMembership) {
      for (const alias of [identity.documentUuid, identity.pdfUuid]) {
        if (alias === undefined) continue;
        const previous = aliases.get(alias);
        if (previous === undefined) aliases.set(alias, key);
        else dsu.union(previous, key);
      }
    }
    const partitionsByRoot = new Map<string, Set<string>>();
    for (const key of keys) {
      const root = dsu.find(key);
      const partitions = partitionsByRoot.get(root) ?? new Set<string>();
      partitions.add(key.split("\u0000", 1)[0] ?? "");
      partitionsByRoot.set(root, partitions);
    }
    const counts = new Map<string, number>();
    for (const partitions of partitionsByRoot.values()) {
      const key = [...partitions].sort().join("\u0000");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts]
      .map(([key, documents]) => ({ partitions: key.split("\u0000"), documents }))
      .sort((left, right) =>
        left.partitions.join("\u0000").localeCompare(right.partitions.join("\u0000")),
      );
  }

  newInPass(partitionId: string, pass: number): number {
    let total = 0;
    for (const key of this.#passKeys) {
      if (key.startsWith(`${partitionId}\u0000${String(pass)}\u0000`)) total += 1;
    }
    return total;
  }

  #remember(membership: CorpusMembership): void {
    this.#passKeys.add(
      passKey(membership.partitionId, membership.pass, membership.membershipToken),
    );
    this.#partitionKeys.add(partitionKey(membership.partitionId, membership.membershipToken));
    const key = partitionKey(membership.partitionId, membership.membershipToken);
    const previous = this.#identityByMembership.get(key);
    this.#identityByMembership.set(key, {
      ...(previous?.documentUuid === undefined ? {} : { documentUuid: previous.documentUuid }),
      ...(previous?.pdfUuid === undefined ? {} : { pdfUuid: previous.pdfUuid }),
      ...(membership.identity.documentUuid === undefined
        ? {}
        : { documentUuid: membership.identity.documentUuid }),
      ...(membership.identity.pdfUuid === undefined
        ? {}
        : { pdfUuid: membership.identity.pdfUuid }),
    });
  }
}
