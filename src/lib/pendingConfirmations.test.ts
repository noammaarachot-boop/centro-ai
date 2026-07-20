import { describe, expect, it } from "vitest";
import { parseConfirmationReply } from "./pendingConfirmations";

describe("parseConfirmationReply", () => {
  it("recognizes clear Hebrew and English affirmative replies", () => {
    for (const text of ["כן", "כן בבקשה", "אישור", "מאשר", "בטח", "בסדר גמור", "yes", "Yes please"]) {
      expect(parseConfirmationReply(text), `"${text}"`).toBe("yes");
    }
  });

  it("recognizes clear negative replies", () => {
    for (const text of ["לא", "לא תודה", "לא צריך את זה", "no"]) {
      expect(parseConfirmationReply(text), `"${text}"`).toBe("no");
    }
  });

  it("never guesses at an unclear or unrelated reply", () => {
    for (const text of ["", "מה זאת אומרת?", "אני לא בטוח", "שלום", "מתי זה מגיע"]) {
      expect(parseConfirmationReply(text), `"${text}"`).toBe("unclear");
    }
  });

  it("prefers a clear 'no' even when the reply also contains the substring for 'yes'", () => {
    // "לא צריך" contains no overlap with the "yes" list, but this
    // documents the intentional check order (no checked before yes).
    expect(parseConfirmationReply("לא, לא צריך")).toBe("no");
  });

  it("does not misread a word merely appearing inside a longer, uncertain sentence", () => {
    // Regression: "אני לא בטוח" ("I'm not sure") contains "לא" ("no") as a
    // substring but does not lead with it — must stay unclear, never a
    // confident "no".
    expect(parseConfirmationReply("אני לא בטוח")).toBe("unclear");
    expect(parseConfirmationReply("תגידו לי, כן זה עובד?")).toBe("unclear");
  });
});
