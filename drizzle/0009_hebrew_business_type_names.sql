-- Data-only migration (no schema change) — upgrades existing installations
-- automatically instead of requiring a fresh database.
--
-- The five starter Business Types were originally seeded with English
-- canonical names (Limited Company, Sole Proprietor, Exempt Business,
-- Nonprofit, Payroll Only). A later change moved the canonical names to
-- Hebrew, but seedStarterBusinessTypes() is deliberately idempotent-by-name
-- — it only creates types an org doesn't already have, so it never touched
-- rows an org had already seeded before that change. Two visible symptoms
-- of the same root cause: (1) the wizard and /services still showed the
-- old English names for those orgs, and (2) the classifier's Hebrew
-- synonym dictionary resolves to the new Hebrew canonical names, which no
-- longer matched that org's actual (English) business_types rows — so
-- every classification attempt silently found no candidate and fell
-- through to Unclassified, regardless of a correct Business Type column
-- in the file.
--
-- Renames both business_types.name and its backing services.name (the
-- latter is what /services and Collection Requests display) for every
-- organization still on the old names, plus the standard document
-- requirement labels those five services were originally seeded with —
-- but only when the name is still exactly one of the known original
-- English defaults, so a firm that already renamed or edited its own
-- checklist is left untouched.
--
-- PGlite/Postgres cannot prepare more than one command per statement, so
-- every individual UPDATE below needs its own --> statement-breakpoint
-- marker (drizzle-orm's migrator splits the file on these) rather than
-- batching several per marker.

-- Business Types
UPDATE "business_types" SET "name" = 'חברה בע"מ' WHERE "name" = 'Limited Company';
--> statement-breakpoint
UPDATE "business_types" SET "name" = 'עוסק מורשה' WHERE "name" = 'Sole Proprietor';
--> statement-breakpoint
UPDATE "business_types" SET "name" = 'עוסק פטור' WHERE "name" = 'Exempt Business';
--> statement-breakpoint
UPDATE "business_types" SET "name" = 'עמותה' WHERE "name" = 'Nonprofit';
--> statement-breakpoint
UPDATE "business_types" SET "name" = 'שכר בלבד' WHERE "name" = 'Payroll Only';
--> statement-breakpoint

-- Their backing Services (what /services and Collection Requests display)
UPDATE "services" SET "name" = 'חברה בע"מ' WHERE "name" = 'Limited Company';
--> statement-breakpoint
UPDATE "services" SET "name" = 'עוסק מורשה' WHERE "name" = 'Sole Proprietor';
--> statement-breakpoint
UPDATE "services" SET "name" = 'עוסק פטור' WHERE "name" = 'Exempt Business';
--> statement-breakpoint
UPDATE "services" SET "name" = 'עמותה' WHERE "name" = 'Nonprofit';
--> statement-breakpoint
UPDATE "services" SET "name" = 'שכר בלבד' WHERE "name" = 'Payroll Only';
--> statement-breakpoint

-- Standard document-requirement labels seeded for those same five services,
-- scoped to services now named with the new Hebrew canonical name (i.e.
-- exactly the ones the updates above just renamed) so a requirement a user
-- added themselves with a coincidentally matching English name on an
-- unrelated custom service is never touched.
UPDATE "service_document_requirements" SET "name" = 'חשבוניות הוצאה'
  WHERE "name" = 'Expense Invoices'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עוסק מורשה', 'עוסק פטור', 'עמותה'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'חשבוניות הכנסה'
  WHERE "name" = 'Income Invoices'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עוסק מורשה', 'עוסק פטור', 'עמותה'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'דפי חשבון בנק'
  WHERE "name" = 'Bank Statements'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עוסק מורשה', 'עוסק פטור', 'עמותה', 'שכר בלבד'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'דפי כרטיס אשראי'
  WHERE "name" = 'Credit Card Statements'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עוסק מורשה'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'דוחות שכר'
  WHERE "name" = 'Payroll Reports'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עמותה', 'שכר בלבד'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'טפסי עובדים'
  WHERE "name" = 'Employee Forms'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עמותה', 'שכר בלבד'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'דוחות מע"מ'
  WHERE "name" = 'VAT Reports'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עוסק מורשה'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'הוצאות רכב'
  WHERE "name" = 'Vehicle Expenses'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עוסק מורשה'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'קופה קטנה'
  WHERE "name" = 'Petty Cash'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" IN ('חברה בע"מ', 'עוסק מורשה', 'עוסק פטור'));
--> statement-breakpoint
UPDATE "service_document_requirements" SET "name" = 'דוח שנתי'
  WHERE "name" = 'Annual Report'
  AND "service_id" IN (SELECT "id" FROM "services" WHERE "name" = 'עמותה');
