import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Real DB-integration coverage (ephemeral in-memory PGlite, the same
// Postgres-in-WASM the app uses for local dev — nothing shared, nothing
// persisted) for the folder-resolution race/collision/reuse logic, plus a
// tiny in-memory fake of the Drive API surface itself. The one thing a
// fully-mocked DB layer can't prove is whether pg_advisory_xact_lock
// actually serializes two concurrent callers — PGlite is real Postgres, so
// that guarantee is genuinely exercised here, not assumed.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const getValidAccessToken = vi.fn();
vi.mock("@/lib/googleAuth/driveTokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/driveTokens")>("@/lib/googleAuth/driveTokens");
  return { ...actual, getValidAccessToken: (...args: unknown[]) => getValidAccessToken(...args) };
});

interface FakeFolder {
  id: string;
  name: string;
  parentId: string;
  properties?: Record<string, string>;
  trashed?: boolean;
}
interface FakeFile {
  id: string;
  name: string;
  parentId: string;
}
let fakeFolders: FakeFolder[] = [];
let fakeFiles: FakeFile[] = [];
let nextId = 1;

vi.mock("@/lib/googleAuth/drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/drive")>("@/lib/googleAuth/drive");
  return {
    ...actual,
    createDriveFolder: vi.fn(
      async (_token: string, name: string, parentId?: string, properties?: Record<string, string>) => {
        const id = `folder-${nextId++}`;
        fakeFolders.push({ id, name, parentId: parentId ?? "", properties });
        return { id, name };
      }
    ),
    findFoldersByName: vi.fn(async (_token: string, parentId: string, name: string) =>
      fakeFolders
        .filter((f) => f.parentId === parentId && f.name === name && !f.trashed)
        .map((f) => ({ id: f.id, name: f.name }))
    ),
    findFolderByClientProperty: vi.fn(async (_token: string, parentId: string, clientId: string) => {
      const found = fakeFolders.find(
        (f) => f.parentId === parentId && !f.trashed && f.properties?.centroClientId === clientId
      );
      return found ? { id: found.id, name: found.name } : null;
    }),
    setFolderClientProperty: vi.fn(async (_token: string, folderId: string, clientId: string) => {
      const folder = fakeFolders.find((f) => f.id === folderId);
      if (folder) folder.properties = { ...folder.properties, centroClientId: clientId };
    }),
    listFolderFiles: vi.fn(async (_token: string, folderId: string) =>
      fakeFiles.filter((f) => f.parentId === folderId).map((f) => ({ id: f.id, name: f.name, webViewLink: null }))
    ),
    moveDriveFile: vi.fn(async (_token: string, fileId: string, _from: string, toParentId: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) file.parentId = toParentId;
    }),
    trashDriveFolder: vi.fn(async (_token: string, folderId: string) => {
      const folder = fakeFolders.find((f) => f.id === folderId);
      if (folder) folder.trashed = true;
    }),
    uploadDriveFile: vi.fn(async (_token: string, options: { name: string; parentId: string }) => {
      const id = `file-${nextId++}`;
      fakeFiles.push({ id, name: options.name, parentId: options.parentId });
      return { id, name: options.name, webViewLink: `https://drive.example/${id}` };
    }),
  };
});

const { ensureClientFolder, mergeDuplicateClientFolders, uploadDocument } = await import("./driveAdapter");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  fakeFolders = [];
  fakeFiles = [];
  getValidAccessToken.mockResolvedValue("fake-token");
});

async function seedOrgWithClient(clientName: string) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "parent-1" })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: clientName, phone: "+972500000000" })
    .returning();
  return { orgId: org.id, clientId: client.id };
}

describe("ensureClientFolder", () => {
  it("creates exactly one folder and stores its id on the client", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    const result = await ensureClientFolder(clientId);
    expect(fakeFolders).toHaveLength(1);
    expect(fakeFolders[0].name).toBe("רז שלום");
    const [row] = await db
      .select({ driveFolderId: schema.clients.driveFolderId })
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId));
    expect(row.driveFolderId).toBe(result.folderId);
  });

  it("reuses the stored folder id on a second call, without creating another folder", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    const first = await ensureClientFolder(clientId);
    const second = await ensureClientFolder(clientId);
    expect(second.folderId).toBe(first.folderId);
    expect(fakeFolders).toHaveLength(1);
  });

  it("race safety: two concurrent calls for the same client create only one folder", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    const [a, b] = await Promise.all([ensureClientFolder(clientId), ensureClientFolder(clientId)]);
    expect(a.folderId).toBe(b.folderId);
    expect(fakeFolders).toHaveLength(1);
  });

  it("uses the bare client name when no collision exists", async () => {
    const { clientId } = await seedOrgWithClient("דנה כהן");
    await ensureClientFolder(clientId);
    expect(fakeFolders[0].name).toBe("דנה כהן");
  });

  it("suffixes the folder name only when a different client already has that exact name in the same parent", async () => {
    const { orgId, clientId: firstClientId } = await seedOrgWithClient("רז שלום");
    await ensureClientFolder(firstClientId);

    const [secondClient] = await db
      .insert(schema.clients)
      .values({ organizationId: orgId, name: "רז שלום", phone: "+972500000001" })
      .returning();
    const result = await ensureClientFolder(secondClient.id);
    const created = fakeFolders.find((f) => f.id === result.folderId);
    expect(created?.name).toBe(`רז שלום - ${secondClient.id.slice(-5)}`);
    expect(fakeFolders).toHaveLength(2);
  });
});

describe("mergeDuplicateClientFolders", () => {
  it("moves every file from duplicate folders into the primary and trashes the duplicates", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    // Simulate the pre-fix race: two folders with the identical name, files split across both.
    fakeFolders.push({ id: "dup-a", name: "רז שלום", parentId: "parent-1" });
    fakeFolders.push({ id: "dup-b", name: "רז שלום", parentId: "parent-1" });
    fakeFiles.push({ id: "file-1", name: "תעודת זהות.jpg", parentId: "dup-a" });
    fakeFiles.push({ id: "file-2", name: "רישיון נהיגה.jpg", parentId: "dup-b" });
    await db.update(schema.clients).set({ driveFolderId: "dup-a" }).where(eq(schema.clients.id, clientId));

    const result = await mergeDuplicateClientFolders(clientId);

    expect(result.primaryFolderId).toBe("dup-a");
    expect(result.duplicatesMerged).toBe(1);
    expect(result.filesMoved).toBe(1);
    expect(fakeFiles.every((f) => f.parentId === "dup-a")).toBe(true);
    expect(fakeFolders.find((f) => f.id === "dup-b")?.trashed).toBe(true);
    const [row] = await db
      .select({ driveFolderId: schema.clients.driveFolderId })
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId));
    expect(row.driveFolderId).toBe("dup-a");
  });

  it("is a no-op when there is nothing to merge", async () => {
    const { clientId } = await seedOrgWithClient("יחיד");
    await ensureClientFolder(clientId);
    const result = await mergeDuplicateClientFolders(clientId);
    expect(result.duplicatesMerged).toBe(0);
    expect(fakeFolders).toHaveLength(1);
  });
});

describe("uploadDocument — file naming", () => {
  it("names the Drive file after the matched requirement, not the raw stored fileName", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "Service" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "p" })
      .returning();
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name: "תעודת זהות" })
      .returning();
    const [document] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: request.id,
        requirementId: requirement.id,
        fileName: "image_wamid.abc123.jpg",
        status: "approved",
      })
      .returning();

    await uploadDocument(clientId, document.id, Buffer.from("fake"), "image/jpeg");

    expect(fakeFiles[0].name).toBe("תעודת זהות.jpg");
  });

  it("avoids overwriting when the same requirement name is uploaded twice", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "Service" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "p" })
      .returning();
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name: "תעודת זהות" })
      .returning();

    const insertDoc = () =>
      db
        .insert(schema.documents)
        .values({
          organizationId: orgId,
          collectionRequestId: request.id,
          requirementId: requirement.id,
          fileName: "image_a.jpg",
          status: "approved",
        })
        .returning();

    const [doc1] = await insertDoc();
    await uploadDocument(clientId, doc1.id, Buffer.from("fake"), "image/jpeg");
    const [doc2] = await insertDoc();
    await uploadDocument(clientId, doc2.id, Buffer.from("fake"), "image/jpeg");

    const names = fakeFiles.map((f) => f.name).sort();
    expect(names).toEqual(["תעודת זהות (2).jpg", "תעודת זהות.jpg"]);
  });
});
