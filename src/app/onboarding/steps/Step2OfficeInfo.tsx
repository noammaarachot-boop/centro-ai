import { OfficeInfoForm } from "@/components/app/OfficeInfoForm";

export function Step2OfficeInfo({
  name,
  logoUrl,
}: {
  name: string;
  logoUrl: string | null;
}) {
  return <OfficeInfoForm name={name} logoUrl={logoUrl} submitLabel="המשך" />;
}
