import type { Jurisdiction } from "./types";

export type RegistryId = "gmc" | "nmc" | "sra" | "companies-house" | "cslb" | "ca-dca" | "fl-sunbiz";

/**
 * Each registry's public name (spec section 6), country and the page a person can search it
 * on. One source of truth: the adapters read `name`, `country` and `searchUrl` from here, and
 * the public record uses it for `registry_name`, `country` and the `source_url` of a result
 * that has no record page.
 */
export const REGISTRY_META: Record<RegistryId, { name: string; country: Jurisdiction; searchUrl: string }> = {
  gmc: {
    name: "General Medical Council",
    country: "GB",
    searchUrl: "https://www.gmc-uk.org/registration-and-licensing/the-medical-register",
  },
  nmc: {
    name: "Nursing and Midwifery Council",
    country: "GB",
    searchUrl: "https://www.nmc.org.uk/registration/search-the-register/",
  },
  sra: {
    name: "Solicitors Regulation Authority",
    country: "GB",
    searchUrl: "https://www.sra.org.uk/consumers/register/",
  },
  "companies-house": {
    name: "Companies House",
    country: "GB",
    searchUrl: "https://find-and-update.company-information.service.gov.uk/search/companies",
  },
  cslb: {
    name: "CA Contractors State License Board",
    country: "US-CA",
    searchUrl: "https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx",
  },
  "ca-dca": {
    name: "CA Department of Consumer Affairs",
    country: "US-CA",
    searchUrl: "https://search.dca.ca.gov/",
  },
  "fl-sunbiz": {
    name: "Florida Division of Corporations (Sunbiz)",
    country: "US-FL",
    searchUrl: "https://search.sunbiz.org/Inquiry/CorporationSearch/ByName",
  },
};
