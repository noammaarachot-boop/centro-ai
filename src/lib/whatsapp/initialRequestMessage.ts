import { formatRequirementListForTemplateParam } from "@/lib/documentRequestList";
import {
  INITIAL_REQUEST_BODY,
  INITIAL_REQUEST_V2_BODY,
  INITIAL_REQUEST_V2_ENABLED,
  INITIAL_REQUEST_V2_TEMPLATE_NAME,
} from "./templates";

export interface InitialRequestSend {
  // Which approved Meta template to send.
  templateName: string;
  language: string;
  // Body parameters for that template (empty for the static v1 template).
  params: string[];
  // The human-readable text stored on the outbound message row — for v2 this
  // is INITIAL_REQUEST_V2_BODY with {{1}} already substituted, so the DB /
  // conversation view shows exactly what the client received.
  renderedBody: string;
  usedV2: boolean;
}

// Decides how to send the initial document request for a specific Collection
// Request, from that request's own (already resolved) requirement names.
//
// The v2 (parameterized, dynamic-list) template is used only when it is
// enabled AND the request actually has requirements — otherwise it falls back
// to the static v1 template, which is also exactly the current production
// behavior while v2 approval is pending. `v2Enabled` is injectable purely so
// the v2 branch can be unit-tested before the real flag is turned on.
export function buildInitialRequestSend(
  requirementNames: string[],
  v2Enabled: boolean = INITIAL_REQUEST_V2_ENABLED
): InitialRequestSend {
  if (v2Enabled && requirementNames.length > 0) {
    const listParam = formatRequirementListForTemplateParam(requirementNames);
    return {
      templateName: INITIAL_REQUEST_V2_TEMPLATE_NAME,
      language: "he",
      params: [listParam],
      renderedBody: INITIAL_REQUEST_V2_BODY.replace("{{1}}", listParam),
      usedV2: true,
    };
  }
  return {
    templateName: "centro_initial_request",
    language: "he",
    params: [],
    renderedBody: INITIAL_REQUEST_BODY,
    usedV2: false,
  };
}
