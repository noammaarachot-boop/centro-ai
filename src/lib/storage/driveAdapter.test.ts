import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Real DB-integration coverage (ephemeral in-memory PGlite, the same
// Postgres-in-WASM the app uses for local dev — nothing shared, nothing
// persisted) for the monthly folder-path resolution's race/collision/reuse
// logic, plus a tiny in-memory fake of the Drive API surface itself. The
// one thing a fully-mocked DB layer can't prove is whether
// pg_advisory_xact_lock actually serializes two concurrent callers —
// PGlite is real Postgres, so that guarantee is genuinely exercised here,
// not assumed.

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
      if (file) {
        file.parentId = toParentId;
        return;
      }
      // moveDriveFile is also used to relocate a *folder* (Drive treats
      // folders as files with a mimeType) — see relocateLegacyClientFolder.
      const folder = fakeFolders.find((f) => f.id === fileId);
      if (folder) folder.parentId = toParentId;
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

const {
  ensureDrivePath,
  ensureCollectionRequestDriveFolder,
  mergeDuplicateClientFolders,
  relocateLegacyClientFolder,
  uploadDocument,
  formatHebrewMonthYear,
} = await import("./driveAdapter");

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
    .values({ name: "Org", googleDriveFolderId: "root-1" })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: clientName, phone: "+972500000000" })
    .returning();
  return { orgId: org.id, clientId: client.id };
}

async function seedRequest(orgId: string, clientId: string, createdAt: Date) {
  const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "p", createdAt })
    .returning();
  return request.id;
}

describe("formatHebrewMonthYear", () => {
  it("formats a plain mid-month date", () => {
    expect(formatHebrewMonthYear(new Date("2026-08-15T10:00:00Z"))).toBe("אוגוסט 2026");
  });

  it("uses Israel local time at a month boundary, not the server's own timezone", () => {
    // 2026-08-31 23:30 Israel time (UTC+3 in August) is 2026-08-31 20:30 UTC
    // — same month either way, this just pins the timezone the function
    // must use rather than whatever the process happens to run in.
    expect(formatHebrewMonthYear(new Date("2026-08-31T20:30:00Z"))).toBe("אוגוסט 2026");
    // 2026-09-01 00:30 Israel time is 2026-08-31 21:30 UTC — a UTC-based
    // implementation would wrongly say אוגוסט; Israel time correctly says ספטמבר.
    expect(formatHebrewMonthYear(new Date("2026-08-31T21:30:00Z"))).toBe("ספטמבר 2026");
  });
});

describe("ensureDrivePath", () => {
  it("creates the month folder under root and the client folder under the month folder", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    const result = await ensureDrivePath("root-1", new Date("2026-08-15T10:00:00Z"), clientId, "רז שלום");

    const monthFolder = fakeFolders.find((f) => f.parentId === "root-1");
    expect(monthFolder?.name).toBe("אוגוסט 2026");
    const clientFolder = fakeFolders.find((f) => f.id === result.driveClientFolderId);
    expect(clientFolder?.parentId).toBe(monthFolder?.id);
    expect(clientFolder?.name).toBe("רז שלום");
  });

  it("reuses the same month folder for a second client in the same month", async () => {
    const { clientId: client1 } = await seedOrgWithClient("רז שלום");
    const { clientId: client2 } = await seedOrgWithClient("דנה כהן");
    await ensureDrivePath("root-1", new Date("2026-08-05T10:00:00Z"), client1, "רז שלום");
    await ensureDrivePath("root-1", new Date("2026-08-20T10:00:00Z"), client2, "דנה כהן");

    const monthFolders = fakeFolders.filter((f) => f.parentId === "root-1" && f.name === "אוגוסט 2026");
    expect(monthFolders).toHaveLength(1);
  });

  it("creates separate month folders for requests in different months", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    await ensureDrivePath("root-1", new Date("2026-08-15T10:00:00Z"), clientId, "רז שלום");
    await ensureDrivePath("root-1", new Date("2026-09-15T10:00:00Z"), clientId, "רז שלום");

    const monthFolders = fakeFolders.filter((f) => f.parentId === "root-1");
    expect(monthFolders.map((f) => f.name).sort()).toEqual(["אוגוסט 2026", "ספטמבר 2026"]);
  });

  it("race safety: two concurrent calls for the same client+month create only one month folder and one client folder", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    const [a, b] = await Promise.all([
      ensureDrivePath("root-1", new Date("2026-08-15T10:00:00Z"), clientId, "רז שלום"),
      ensureDrivePath("root-1", new Date("2026-08-15T10:00:00Z"), clientId, "רז שלום"),
    ]);
    expect(a.driveClientFolderId).toBe(b.driveClientFolderId);
    expect(fakeFolders.filter((f) => f.parentId === "root-1")).toHaveLength(1); // one month folder
    expect(fakeFolders).toHaveLength(2); // month + client, no duplicate client folder
  });

  it("suffixes the client folder name only on a genuine collision with a different client in the same month", async () => {
    const { orgId, clientId: firstClientId } = await seedOrgWithClient("רז שלום");
    await ensureDrivePath("root-1", new Date("2026-08-15T10:00:00Z"), firstClientId, "רז שלום");

    const [secondClient] = await db
      .insert(schema.clients)
      .values({ organizationId: orgId, name: "רז שלום", phone: "+972500000001" })
      .returning();
    const result = await ensureDrivePath("root-1", new Date("2026-08-20T10:00:00Z"), secondClient.id, "רז שלום");
    const created = fakeFolders.find((f) => f.id === result.driveClientFolderId);
    expect(created?.name).toBe(`רז שלום - ${secondClient.id.slice(-5).toUpperCase()}`);
  });
});

describe("ensureCollectionRequestDriveFolder", () => {
  it("resolves once and caches driveClientFolderId on the collection request", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const requestId = await seedRequest(orgId, clientId, new Date("2026-08-15T10:00:00Z"));

    const first = await ensureCollectionRequestDriveFolder(requestId);
    const [row] = await db
      .select({ driveClientFolderId: schema.collectionRequests.driveClientFolderId })
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, requestId));
    expect(row.driveClientFolderId).toBe(first.folderId);

    const second = await ensureCollectionRequestDriveFolder(requestId);
    expect(second.folderId).toBe(first.folderId);
    // Still just one month folder + one client folder — the second call
    // used the cached id, no fresh Drive resolution.
    expect(fakeFolders).toHaveLength(2);
  });

  it("reuses the same client folder for 10 documents arriving over time (simulated by 10 concurrent resolutions)", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const requestId = await seedRequest(orgId, clientId, new Date("2026-08-15T10:00:00Z"));

    const results = await Promise.all(Array.from({ length: 10 }, () => ensureCollectionRequestDriveFolder(requestId)));
    const distinctFolderIds = new Set(results.map((r) => r.folderId));
    expect(distinctFolderIds.size).toBe(1);
    expect(fakeFolders).toHaveLength(2); // one month folder, one client folder — never 10
  });
});

describe("relocateLegacyClientFolder", () => {
  it("moves a flat root-level folder into the correct month folder and links it to the right request", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const requestId = await seedRequest(orgId, clientId, new Date("2026-08-10T10:00:00Z"));
    // Simulate the pre-monthly-structure legacy layout: a folder directly under root.
    fakeFolders.push({ id: "legacy-folder", name: "רז שלום", parentId: "root-1" });
    await db.update(schema.clients).set({ driveFolderId: "legacy-folder" }).where(eq(schema.clients.id, clientId));

    const result = await relocateLegacyClientFolder(clientId);

    expect(result.relocated).toBe(true);
    expect(result.collectionRequestId).toBe(requestId);
    const moved = fakeFolders.find((f) => f.id === "legacy-folder");
    expect(moved?.parentId).not.toBe("root-1");
    const monthFolder = fakeFolders.find((f) => f.id === moved?.parentId);
    expect(monthFolder?.name).toBe("אוגוסט 2026");
    const [row] = await db
      .select({ driveClientFolderId: schema.collectionRequests.driveClientFolderId })
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, requestId));
    expect(row.driveClientFolderId).toBe("legacy-folder");
  });

  it("is a no-op for a client with no legacy flat folder", async () => {
    const { clientId } = await seedOrgWithClient("יחיד");
    const result = await relocateLegacyClientFolder(clientId);
    expect(result.relocated).toBe(false);
  });
});

describe("mergeDuplicateClientFolders", () => {
  it("moves every file from duplicate folders into the primary and trashes the duplicates", async () => {
    const { clientId } = await seedOrgWithClient("רז שלום");
    fakeFolders.push({ id: "dup-a", name: "רז שלום", parentId: "root-1" });
    fakeFolders.push({ id: "dup-b", name: "רז שלום", parentId: "root-1" });
    fakeFiles.push({ id: "file-1", name: "תעודת זהות.jpg", parentId: "dup-a" });
    fakeFiles.push({ id: "file-2", name: "רישיון נהיגה.jpg", parentId: "dup-b" });

    const result = await mergeDuplicateClientFolders(clientId, "root-1");

    expect(result.duplicatesMerged).toBe(1);
    expect(result.filesMoved).toBe(1);
    expect(fakeFiles.every((f) => f.parentId === result.primaryFolderId)).toBe(true);
    const duplicate = fakeFolders.find((f) => f.id !== result.primaryFolderId && f.name === "רז שלום");
    expect(duplicate?.trashed).toBe(true);
  });

  it("is a no-op when there is nothing to merge", async () => {
    const { clientId } = await seedOrgWithClient("יחיד");
    const result = await mergeDuplicateClientFolders(clientId, "root-1");
    expect(result.duplicatesMerged).toBe(0);
  });
});

describe("uploadDocument — file naming", () => {
  it("names the Drive file after the matched requirement and places it in the request's client folder", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const requestId = await seedRequest(orgId, clientId, new Date("2026-08-15T10:00:00Z"));
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: requestId, name: "תעודת זהות" })
      .returning();
    const [document] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        requirementId: requirement.id,
        fileName: "image_wamid.abc123.jpg",
        status: "approved",
      })
      .returning();

    await uploadDocument(clientId, document.id, requestId, Buffer.from("fake"), "image/jpeg");

    expect(fakeFiles[0].name).toBe("תעודת זהות.jpg");
    const clientFolder = fakeFolders.find((f) => f.id === fakeFiles[0].parentId);
    expect(clientFolder?.name).toBe("רז שלום");
    const monthFolder = fakeFolders.find((f) => f.id === clientFolder?.parentId);
    expect(monthFolder?.name).toBe("אוגוסט 2026");
  });

  it("uses a version suffix — never overwrites — when the same requirement name is uploaded twice", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const requestId = await seedRequest(orgId, clientId, new Date("2026-08-15T10:00:00Z"));
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: requestId, name: "תעודת זהות" })
      .returning();

    const insertDoc = () =>
      db
        .insert(schema.documents)
        .values({
          organizationId: orgId,
          collectionRequestId: requestId,
          requirementId: requirement.id,
          fileName: "image_a.jpg",
          status: "approved",
        })
        .returning();

    const [doc1] = await insertDoc();
    await uploadDocument(clientId, doc1.id, requestId, Buffer.from("fake"), "image/jpeg");
    const [doc2] = await insertDoc();
    await uploadDocument(clientId, doc2.id, requestId, Buffer.from("fake"), "image/jpeg");

    const names = fakeFiles.map((f) => f.name).sort();
    expect(names).toEqual(["תעודת זהות - גרסה 2.jpg", "תעודת זהות.jpg"]);
  });

  it("all 10 documents of one request land in the exact same client folder", async () => {
    const { orgId, clientId } = await seedOrgWithClient("רז שלום");
    const requestId = await seedRequest(orgId, clientId, new Date("2026-08-15T10:00:00Z"));
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: requestId, name: "מסמך" })
      .returning();

    for (let i = 0; i < 10; i += 1) {
      const [doc] = await db
        .insert(schema.documents)
        .values({
          organizationId: orgId,
          collectionRequestId: requestId,
          requirementId: requirement.id,
          fileName: `image_${i}.jpg`,
          status: "approved",
        })
        .returning();
      await uploadDocument(clientId, doc.id, requestId, Buffer.from("fake"), "image/jpeg");
    }

    expect(fakeFiles).toHaveLength(10);
    const distinctParents = new Set(fakeFiles.map((f) => f.parentId));
    expect(distinctParents.size).toBe(1);
    const clientFolders = fakeFolders.filter((f) => f.name === "רז שלום");
    expect(clientFolders).toHaveLength(1);
  });
});
